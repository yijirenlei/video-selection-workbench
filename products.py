"""Local product references and the context passed to Seedance prompt generation."""

import base64
import binascii
from datetime import datetime, timezone
from io import BytesIO
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from uuid import uuid4
import xml.etree.ElementTree as ET
from zipfile import BadZipFile, ZipFile

MAX_ATTACHMENT = 8 * 1024 * 1024
MAX_REQUEST = 34 * 1024 * 1024
IMAGES = {".png", ".jpg", ".jpeg", ".webp"}
TEXT = {".txt", ".md", ".csv", ".tsv", ".json"}
DOCUMENTS = {".pdf", ".docx", ".rtf", ".doc", ".xlsx"}
PDFKIT = '''
import Foundation
import PDFKit
guard let url = CommandLine.arguments.last,
      let document = PDFDocument(url: URL(fileURLWithPath: url)) else { exit(1) }
for index in 0..<min(document.pageCount, 100) {
    if let page = document.page(at: index), let text = page.string { print(text) }
}
'''


def decode_text(data):
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16")
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return data.decode("gb18030", errors="replace")


def spreadsheet_text(data):
    with ZipFile(BytesIO(data)) as book:
        def xml(name):
            if book.getinfo(name).file_size > 8 * 1024 * 1024:
                raise ValueError("表格内容太大，请另存为精简的 CSV。")
            return ET.fromstring(book.read(name))
        names = book.namelist()
        strings = []
        if "xl/sharedStrings.xml" in names:
            strings = ["".join(t.text or "" for t in item.findall(".//{*}t"))
                       for item in xml("xl/sharedStrings.xml").findall("{*}si")]
        rows = []
        for name in sorted(names):
            if not re.fullmatch(r"xl/worksheets/sheet\d+\.xml", name):
                continue
            for row in xml(name).findall(".//{*}row"):
                values = []
                for cell in row.findall("{*}c"):
                    value = cell.findtext("{*}v") or ""
                    if cell.get("t") == "s" and value.isdecimal() and int(value) < len(strings):
                        value = strings[int(value)]
                    if cell.get("t") == "inlineStr":
                        value = "".join(t.text or "" for t in cell.findall(".//{*}t"))
                    if value:
                        values.append(value)
                if values:
                    rows.append(" | ".join(values))
        return "\n".join(rows)


def document_text(path, extension, raw):
    if extension in TEXT:
        return decode_text(raw)
    if extension == ".xlsx":
        return spreadsheet_text(raw)
    if extension == ".pdf":
        if converter := shutil.which("pdftotext"):
            command = [converter, str(path), "-"]
        elif Path("/usr/bin/swift").exists():
            command = ["/usr/bin/swift", "-e", PDFKIT, str(path)]
        else:
            raise ValueError("请安装 pdftotext，或把 PDF 卖点粘贴成文字。")
    elif extension == ".docx":
        with ZipFile(BytesIO(raw)) as document:
            entry = document.getinfo("word/document.xml")
            if entry.file_size > 8 * 1024 * 1024:
                raise ValueError("文档内容太大，请拆分后上传。")
            root = ET.fromstring(document.read(entry))
            return "\n".join("".join(t.text or "" for t in p.findall(".//{*}t"))
                             for p in root.findall(".//{*}p"))
    else:
        if not Path("/usr/bin/textutil").exists():
            raise ValueError("请把 Word 或 RTF 另存为 DOCX 或纯文本。")
        command = ["/usr/bin/textutil", "-convert", "txt", "-stdout", str(path)]
    result = subprocess.run(command, check=True, capture_output=True, timeout=60)
    return decode_text(result.stdout)


def checked_text(value, label, limit):
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError(f"{label}超出长度限制。")
    return value.strip()


def supported_image(raw, extension):
    if extension == ".png":
        return raw.startswith(b"\x89PNG\r\n\x1a\n")
    if extension == ".webp":
        return raw[:4] == b"RIFF" and raw[8:12] == b"WEBP"
    return raw.startswith(b"\xff\xd8\xff")


def save_product(root, body):
    name = checked_text(body.get("name", ""), "产品名", 120)
    notes = checked_text(body.get("notes", ""), "产品文字", 20000)
    files = body.get("files", [])
    if not name:
        raise ValueError("先填写新产品名。")
    if not isinstance(files, list) or len(files) > 8:
        raise ValueError("一次最多上传 8 个产品文件。")
    saved = body.get("save", False)
    if type(saved) is not bool:
        raise ValueError("保存方式无效。")
    directory = root / "products"
    directory.mkdir(exist_ok=True)
    product_id = uuid4().hex
    with tempfile.TemporaryDirectory(prefix=".upload-", dir=directory) as scratch:
        staging = Path(scratch) / product_id
        staging.mkdir()
        attachments = []
        total = 0
        for index, item in enumerate(files, 1):
            if not isinstance(item, dict):
                raise ValueError("附件格式无效。")
            filename = Path(checked_text(item.get("name", ""), "文件名", 250)).name
            extension = Path(filename).suffix.lower()
            if extension not in IMAGES | TEXT | DOCUMENTS:
                raise ValueError(f"{filename} 的格式暂不支持。可上传图片、PDF、Word、XLSX 或文本。")
            encoded = item.get("data")
            if not isinstance(encoded, str) or len(encoded) > 4 * ((MAX_ATTACHMENT + 2) // 3):
                raise ValueError(f"{filename} 超过 8 MB。")
            try:
                raw = base64.b64decode(encoded, validate=True)
            except (ValueError, binascii.Error) as error:
                raise ValueError(f"无法读取 {filename}。") from error
            total += len(raw)
            if len(raw) > MAX_ATTACHMENT or total > 24 * 1024 * 1024:
                raise ValueError("单个附件最多 8 MB，全部附件最多 24 MB。")
            path = staging / f"{index}{extension}"
            path.write_bytes(raw)
            attachment = {"name": filename, "file": path.name, "image": extension in IMAGES}
            try:
                if attachment["image"]:
                    if not supported_image(raw, extension):
                        raise ValueError("图片内容与扩展名不符。")
                    # Verify the image and normalize it for the local Codex image input.
                    thumbnail = path.with_name(f"{index}-reference.png")
                    subprocess.run([
                        "ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-vf",
                        "scale=1200:1200:force_original_aspect_ratio=decrease:force_divisible_by=2",
                        "-frames:v", "1", "-threads", "1", str(thumbnail),
                    ], check=True, capture_output=True, timeout=30)
                    attachment["reference"] = thumbnail.name
                else:
                    content = document_text(path, extension, raw).strip()
                    if not content:
                        raise ValueError("文件没有可读取文字。扫描件可改传图片。")
                    attachment["text"] = content[:30000]
            except (OSError, ValueError, BadZipFile, KeyError, ET.ParseError, subprocess.SubprocessError) as error:
                detail = str(error) if isinstance(error, ValueError) else "请检查文件格式，或把卖点粘贴成文字。"
                raise ValueError(f"读取 {filename} 失败。{detail}") from error
            attachments.append(attachment)
        product = {"id": product_id, "name": name, "notes": notes, "attachments": attachments,
                   "saved": saved, "created": datetime.now(timezone.utc).isoformat()}
        (staging / "product.json").write_text(json.dumps(product, ensure_ascii=False), encoding="utf-8")
        staging.replace(directory / product_id)
    return public_product(product)


def public_product(product):
    return {**product, "attachments": [{"name": item["name"], "image": item["image"]}
                                        for item in product["attachments"]]}


def load_product(root, product_id):
    if not isinstance(product_id, str) or not re.fullmatch(r"[0-9a-f]{32}", product_id):
        raise ValueError("产品记录不存在。")
    directory = root / "products" / product_id
    try:
        return json.loads((directory / "product.json").read_text(encoding="utf-8")), directory
    except FileNotFoundError as error:
        raise ValueError("产品记录不存在。") from error


def list_products(root):
    products = [json.loads(path.read_text(encoding="utf-8"))
                for path in (root / "products").glob("*/product.json")]
    return [public_product(item) for item in sorted(products, key=lambda item: item["created"], reverse=True)
            if item["saved"]]


def product_context(root, product_id):
    if product_id is None:
        return "", []
    product, directory = load_product(root, product_id)
    text = [f'新产品名：{product["name"]}']
    if product["notes"]:
        text.append(product["notes"])
    images = []
    available = 42000
    for item in product["attachments"]:
        if item["image"]:
            images.append(directory / item["reference"])
        elif available > 0:
            content = item["text"][:available]
            text.append(f'产品文件「{item["name"]}」\n{content}')
            available -= len(content)
    return "\n\n".join(text), images
