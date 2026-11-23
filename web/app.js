"use strict";

const byId = (id) => document.getElementById(id);
const player = byId("player");
const framePreview = byId("frame-preview");
const filmstrip = byId("filmstrip");
const timeline = byId("timeline");
const jumpInput = byId("jump");
const sequencePlayer = byId("sequence-player");
const sequenceProgress = byId("sequence-progress");
const finePanel = byId("fine-panel");
const fineInput = byId("fine-input");
const fineMark = byId("fine-mark");
const hoverPlayer = byId("segment-hover-video");
const productDialog = byId("product-dialog");
const track = byId("track");
const pending = new Map();
const jobs = new Map();
let videos = [];
let active = null;
let stage = 0;
let times = [];
let frameIndex = 0;
let choice = 0;
let frameTimer;
let saving = false;
let importing = false;
let changingStep = false;
let enqueuing = false;
let resultStamp = "";
let previewRevision = 0;
let previewTimer;
let sequenceReady = false;
let sequenceLimit = null;
let pendingSequenceClip = null;
let fineWindow = null;
let mainDrag = null;
let fineTimer;
let scrubAnimation = 0;
let scrubIndex = null;
let slowUntil = null;
let dragIndex = null;
let hoverTimer;
let hoveredClip = null;
let replacement = null;
let productBusy = false;

const videoAPI = (video, action) => `/api/videos/${video.id}/${action}`;
const jobFile = (job, filename) => `/api/jobs/${job.id}/${filename}`;
const asTime = (value) => (Number.isFinite(value) ? value.toFixed(3) : "—");
const frameLabel = (frame) => asTime(times[frame]);
const spanDuration = (segment) => (times[segment.end + 1] ?? active.duration) - times[segment.start];
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const sortByTimeline = (list) => [...list].sort((a, b) => a.start - b.start || a.end - b.end);
const ordered = (video) => video?.manualOrder ? video.segments : sortByTimeline(video?.segments ?? []);
const sameSelection = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const running = (job) => job && ["queued", "working"].includes(job.status);
const jobsFor = (video) => [...jobs.values()].filter((job) => job.video === video?.id);
const chosenMode = () => byId("current-mode").value;
const replacing = () => byId("replace-product").value === "yes";
const requestedProduct = () => replacing() ? replacement?.id ?? null : null;
const sameProduct = (job) => (job.productId ?? null) === requestedProduct();
const completeForMode = (video, mode) => jobsFor(video).some(
  (job) => job.mode === mode && sameProduct(job) && job.status === "done" && sameSelection(job.selection, ordered(video))
);
const busyForMode = (video, mode) => jobsFor(video).some(
  (job) => job.mode === mode && sameProduct(job) && running(job) && sameSelection(job.selection, ordered(video))
);

async function api(path, body) {
  const options = body === undefined ? {} : {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(body),
  };
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败，请重试。");
  return data;
}

function status(id, message = "", error = false) {
  const element = byId(id);
  element.textContent = message;
  element.hidden = !message;
  element.classList.toggle("error", error);
}

function node(tag, className, label) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (label !== undefined) element.textContent = label;
  return element;
}

function smallButton(label, onClick, className) {
  const button = node("button", className, label);
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}

function userDownload(label, url, filename) {
  const link = node("a", "", label);
  link.href = url;
  link.download = filename;
  return link;
}

function paintRanges() {
  const list = byId("ranges");
  list.replaceChildren();
  if (!times.length || !active) return;
  const marker = (start, end, draft = false) => {
    const mark = node("div", draft ? "range-mark pending" : "range-mark");
    const total = Math.max(1, times.length - 1);
    mark.style.left = `${Math.min(start / total * 100, 99.5)}%`;
    mark.style.width = `${(end - start) / total * 100}%`;
    list.append(mark);
  };
  for (const segment of ordered(active)) marker(segment.start, segment.end);
  const start = pending.get(active.id);
  if (start !== undefined) marker(Math.min(start, frameIndex), Math.max(start, frameIndex), true);
}

function updateCursor(index) {
  frameIndex = index;
  timeline.value = index;
  timeline.setAttribute("aria-valuetext", `${frameLabel(index)} 秒，第 ${index + 1} 帧`);
  byId("playhead").style.left = `${index / Math.max(1, times.length - 1) * 100}%`;
  if (document.activeElement !== jumpInput) jumpInput.value = frameLabel(index);
  const draft = active && pending.get(active.id);
  byId("pending").textContent = draft === undefined ? "入点未设置" : `入点 ${frameLabel(draft)} 秒`;
  byId("mark-out").disabled = stage !== 2 || draft === undefined || saving;
  byId("mark-in").querySelector("span").textContent = draft === undefined ? "设入点" : "取消入点";
  fineMark.textContent = draft === undefined ? "设入点" : "设出点并存段";
  fineMark.disabled = saving;
  paintFineCursor();
  if (draft !== undefined) paintRanges();
}

function lowerBound(second) {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (times[mid] < second) low = mid + 1;
    else high = mid;
  }
  return low;
}

function visibleFrame(second) {
  return Math.max(0, Math.min(lowerBound(second + 0.0003) - 1, times.length - 1));
}

function nearestFrame(second) {
  const after = Math.min(lowerBound(second), times.length - 1);
  const before = Math.max(after - 1, 0);
  return Math.abs(times[after] - second) <= Math.abs(times[before] - second) + 0.000001 ? after : before;
}

function exactPreview(index) {
  clearTimeout(frameTimer);
  const revision = choice;
  framePreview.hidden = true;
  frameTimer = setTimeout(() => {
    if (!active || index !== frameIndex || revision !== choice || !player.paused) return;
    const source = `${videoAPI(active, "frame")}?index=${index}`;
    const loaded = new Image();
    loaded.onload = () => {
      if (index !== frameIndex || revision !== choice || !player.paused || mainDrag) return;
      framePreview.src = source;
      framePreview.hidden = false;
    };
    loaded.src = source;
  }, 105);
}

function seekFrame(requested, exact = true) {
  if (!times.length) return;
  if (!player.paused) {
    player.pause();
    queuedPauseFrame = true;
  }
  const index = clamp(requested, 0, times.length - 1);
  updateCursor(index);
  const next = times[index + 1] ?? active.duration;
  if (player.readyState) player.currentTime = times[index] + Math.max(0, Math.min(0.006, (next - times[index]) / 4));
  if (exact) exactPreview(index);
  else {
    clearTimeout(frameTimer);
    framePreview.hidden = true;
  }
}

async function selectVideo(video) {
  if (stage !== 2) return;
  if (active?.id === video.id && times.length) {
    drawLibrary();
    drawSegments();
    queueSequence();
    return;
  }
  const revision = ++choice;
  resetFineInteraction();
  clearSequence();
  clearTimeout(frameTimer);
  active = video;
  byId("sequence-screen").style.setProperty("--preview-ratio", video.width / video.height);
  times = [];
  frameIndex = 0;
  player.pause();
  framePreview.hidden = true;
  filmstrip.hidden = true;
  byId("stage-empty").hidden = true;
  byId("video-title").textContent = video.title;
  byId("video-title").title = video.title;
  byId("video-meta").textContent = `${video.width} × ${video.height} · ${video.duration.toFixed(2)} 秒`;
  byId("total-time").textContent = `/ ${asTime(video.duration)} 秒`;
  jumpInput.value = "0.000";
  timeline.max = "0";
  timeline.value = "0";
  byId("playhead").style.left = "0%";
  byId("pending").textContent = "入点未设置";
  byId("mark-in").querySelector("span").textContent = "设入点";
  const ruler = byId("ruler");
  ruler.replaceChildren(...Array.from({length: 5}, (_, i) => node("span", "", `${Math.round(i * video.duration / 4)}s`)));
  controlAvailability(false);
  drawLibrary();
  drawSegments();
  status("editor-status", "正在读取时间轴…");
  player.src = videoAPI(video, "media");
  player.hidden = false;
  try {
    const {times: frames} = await api(videoAPI(video, "frames"));
    if (revision !== choice) return;
    times = frames;
    timeline.max = String(times.length - 1);
    controlAvailability(true);
    updateCursor(0);
    exactPreview(0);
    const source = videoAPI(video, "strip");
    filmstrip.onload = () => { if (choice === revision) filmstrip.hidden = false; };
    filmstrip.src = source;
    drawSegments();
    queueSequence();
    status("editor-status");
  } catch (error) {
    if (revision === choice) status("editor-status", error.message, true);
  }
}

function controlAvailability(enabled) {
  for (const id of ["play", "back-frame", "forward-frame", "jump", "timeline", "mark-in"]) {
    byId(id).disabled = !enabled;
  }
  if (!enabled) byId("mark-out").disabled = true;
}

let queuedPauseFrame = false;

function togglePlayback() {
  if (!times.length) return;
  if (slowUntil !== null) endSlowPreview();
  if (player.paused) {
    if (player.ended) seekFrame(0);
    player.play().catch(() => status("editor-status", "视频暂时无法播放。", true));
  } else player.pause();
}

function playbackCursor(second) {
  if (!times.length || player.paused) return;
  if (slowUntil !== null && second >= slowUntil) {
    const end = visibleFrame(slowUntil);
    endSlowPreview();
    seekFrame(end);
    return;
  }
  updateCursor(visibleFrame(second));
}

function followFrame(_now, meta) {
  playbackCursor(meta.mediaTime);
  if (!player.paused) player.requestVideoFrameCallback(followFrame);
}

player.addEventListener("play", () => {
  clearTimeout(frameTimer);
  framePreview.hidden = true;
  byId("play").textContent = "暂停";
  if (player.requestVideoFrameCallback) player.requestVideoFrameCallback(followFrame);
});
player.addEventListener("pause", () => {
  byId("play").textContent = "播放";
  if (slowUntil !== null) endSlowPreview();
  if (queuedPauseFrame) queuedPauseFrame = false;
  else if (times.length) {
    updateCursor(visibleFrame(player.currentTime));
    exactPreview(frameIndex);
  }
});
player.addEventListener("ended", () => {
  endSlowPreview();
  if (times.length) {
    updateCursor(times.length - 1);
    exactPreview(frameIndex);
  }
});
player.addEventListener("timeupdate", () => {
  if (!player.requestVideoFrameCallback) playbackCursor(player.currentTime);
});
player.addEventListener("click", togglePlayback);

function jumpToTime() {
  if (!times.length) return;
  const second = Number(jumpInput.value.trim());
  if (!jumpInput.value.trim() || !Number.isFinite(second) || second < 0 || second > active.duration) {
    status("editor-status", "输入视频范围内的秒数，例如 4.25。", true);
    jumpInput.value = frameLabel(frameIndex);
    return;
  }
  seekFrame(nearestFrame(second));
  jumpInput.value = frameLabel(frameIndex);
  status("editor-status");
}
jumpInput.addEventListener("change", jumpToTime);
jumpInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    jumpToTime();
    jumpInput.blur();
  }
});

function videoCard(video, onSelect) {
  const button = onSelect ? smallButton(undefined, onSelect, "video-button") : node("div", "video-button");
  if (onSelect) button.setAttribute("aria-current", active?.id === video.id ? "true" : "false");
  button.title = video.title;
  const poster = node("img", "video-poster");
  poster.alt = "";
  poster.loading = "lazy";
  poster.src = `${videoAPI(video, "frame")}?index=0`;
  const label = node("span", "video-label");
  const description = [`${video.duration.toFixed(1)} 秒`];
  if (video.segments.length) description.push(`${video.segments.length} 个选段`);
  if (jobsFor(video).some(running)) description.push("生成中");
  else if (stage === 3 && completeForMode(video, chosenMode())) description.push("已生成");
  label.append(node("strong", "", video.title), node("small", "", description.join(" · ")));
  button.append(poster, label);
  return button;
}

function drawLibrary() {
  if (stage === 1) {
    byId("import-library-count").textContent = videos.length;
    byId("import-library-list").replaceChildren(...videos.map((video) => videoCard(video)));
  } else if (stage === 2) {
    byId("video-count").textContent = videos.length;
    byId("videos").replaceChildren(...videos.map((video) => videoCard(video, () => selectVideo(video))));
    byId("next-video").disabled = !active || videos.indexOf(active) >= videos.length - 1;
  } else if (stage === 3) {
    const selected = videos.filter((video) => video.segments.length);
    byId("generation-videos").replaceChildren(...selected.map((video) => videoCard(video, () => {
      if (active !== video) times = [];
      active = video;
      drawLibrary();
      drawJob();
    })));
  }
}

function drawSegments() {
  closeClipHover();
  const list = byId("segments");
  const segments = ordered(active);
  list.replaceChildren();
  byId("segment-count").textContent = segments.length;
  byId("segments-empty").hidden = Boolean(segments.length);
  byId("reset-order").hidden = !active?.manualOrder;
  byId("reset-order").disabled = saving;
  for (const [index, segment] of segments.entries()) {
    const card = node("article", "segment");
    card.draggable = true;
    card.dataset.index = index;
    card.addEventListener("pointerenter", (event) => {
      if (event.pointerType === "mouse") hoverSelected(index, card);
    });
    card.addEventListener("pointerleave", closeClipHover);
    card.addEventListener("click", (event) => {
      if (!event.target.closest("button")) previewSelected(index, false);
    });
    card.title = "点击定位这段首帧";
    const title = node("header");
    const handle = node("span", "grip", "⠿");
    handle.setAttribute("aria-hidden", "true");
    title.append(handle, node("h3", "", `${frameLabel(segment.start)} – ${frameLabel(segment.end)} 秒`),
                 node("span", "mono", `${asTime(spanDuration(segment))} 秒`));
    const actions = node("div", "segment-actions");
    const previous = smallButton("上移", () => reorder(index, index - 1));
    const next = smallButton("下移", () => reorder(index, index + 1));
    previous.disabled = !index;
    next.disabled = index === segments.length - 1;
    actions.append(smallButton("播放这段", () => previewSelected(index)), smallButton("定位首帧", () => previewSelected(index, false)), previous, next,
      smallButton("移除", () => saveSegments(active, segments.filter((_, i) => i !== index)), "remove"));
    card.append(title, actions);
    list.append(card);
  }
  paintRanges();
  updateSequenceClock();
  byId("sequence-duration").textContent = `${asTime(times.length ? segments.reduce((sum, item) => sum + spanDuration(item), 0) : 0)} 秒`;
}

function reorder(from, to) {
  if (stage !== 2 || saving || from === to || from == null) return;
  const list = ordered(active).slice();
  if (to < 0 || to >= list.length) return;
  const [segment] = list.splice(from, 1);
  list.splice(to, 0, segment);
  saveSegments(active, list, true);
}

function clearDrag() {
  for (const card of byId("segments").children) card.classList.remove("dragging", "drop-before", "drop-after");
  dragIndex = null;
}

byId("segments").addEventListener("dragstart", (event) => {
  const card = event.target.closest(".segment");
  if (!card || saving || stage !== 2 || event.target.closest("button")) {
    event.preventDefault();
    return;
  }
  dragIndex = Number(card.dataset.index);
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", String(dragIndex));
  card.classList.add("dragging");
});
byId("segments").addEventListener("dragover", (event) => {
  const card = event.target.closest(".segment");
  if (!card || dragIndex === null) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  const rect = card.getBoundingClientRect();
  const after = event.clientY > rect.top + rect.height / 2;
  for (const item of byId("segments").children) item.classList.remove("drop-before", "drop-after");
  if (Number(card.dataset.index) !== dragIndex) card.classList.add(after ? "drop-after" : "drop-before");
});
byId("segments").addEventListener("drop", (event) => {
  const card = event.target.closest(".segment");
  if (!card || dragIndex === null) return;
  event.preventDefault();
  const destination = Number(card.dataset.index);
  const from = dragIndex;
  const after = event.clientY > card.getBoundingClientRect().top + card.getBoundingClientRect().height / 2;
  const insert = destination + (after ? 1 : 0);
  clearDrag();
  if (from !== destination) reorder(from, insert - (from < insert ? 1 : 0));
});
byId("segments").addEventListener("dragend", clearDrag);

function clearSequence() {
  closeClipHover();
  previewRevision++;
  clearTimeout(previewTimer);
  sequenceReady = false;
  sequenceLimit = null;
  pendingSequenceClip = null;
  sequencePlayer.pause();
  sequencePlayer.removeAttribute("src");
  sequencePlayer.load();
  sequencePlayer.hidden = true;
  byId("sequence-controls").hidden = true;
  byId("sequence-empty").hidden = false;
  byId("sequence-empty").textContent = "保存一段后，预览会出现在这里。";
  status("sequence-status");
}

function queueSequence(offset = 0) {
  closeClipHover();
  const video = active;
  if (stage !== 2 || !video || !ordered(video).length) {
    clearSequence();
    return;
  }
  const revision = ++previewRevision;
  clearTimeout(previewTimer);
  sequenceReady = false;
  sequenceLimit = null;
  pendingSequenceClip = null;
  sequencePlayer.pause();
  byId("sequence-controls").hidden = true;
  if (sequencePlayer.hidden) byId("sequence-empty").textContent = "正在准备低清预览…";
  status("sequence-status", "正在更新拼接预览…");
  previewTimer = setTimeout(async () => {
    try {
      const {url} = await api(videoAPI(video, "preview"), {});
      if (stage !== 2 || active !== video || revision !== previewRevision) return;
      const show = () => {
        if (stage !== 2 || active !== video || revision !== previewRevision) return;
        sequenceReady = true;
        sequencePlayer.hidden = false;
        byId("sequence-empty").hidden = true;
        byId("sequence-controls").hidden = false;
        byId("sequence-screen").style.setProperty("--preview-ratio", sequencePlayer.videoWidth / sequencePlayer.videoHeight);
        sequencePlayer.playbackRate = Number(byId("sequence-speed").value);
        sequenceProgress.max = String(sequencePlayer.duration);
        seekSequence(offset);
        status("sequence-status");
        if (pendingSequenceClip !== null) {
          const selection = pendingSequenceClip;
          pendingSequenceClip = null;
          previewSelected(selection.index, selection.play);
        }
      };
      if (sequencePlayer.getAttribute("src") === url && sequencePlayer.readyState >= 1) show();
      else {
        sequencePlayer.addEventListener("loadedmetadata", show, {once: true});
        sequencePlayer.src = url;
      }
    } catch (error) {
      if (revision === previewRevision) {
        sequencePlayer.hidden = true;
        byId("sequence-controls").hidden = true;
        byId("sequence-empty").hidden = false;
        byId("sequence-empty").textContent = "预览加载失败。";
        status("sequence-status", error.message, true);
      }
    }
  }, 180);
}

function updateSequenceClock(position = sequencePlayer.currentTime) {
  const current = sequenceReady ? position : 0;
  const total = sequenceReady ? sequencePlayer.duration : 0;
  sequenceProgress.value = current;
  sequenceProgress.setAttribute("aria-valuetext", `${asTime(current)} / ${asTime(total)} 秒`);
  byId("sequence-time").textContent = `${asTime(current)} / ${asTime(total)} 秒`;
  let offset = 0;
  const entries = ordered(active);
  for (const [index, card] of [...byId("segments").children].entries()) {
    const finish = offset + spanDuration(entries[index]);
    card.classList.toggle("is-previewed", sequenceReady && current + .001 >= offset && current + .001 < finish);
    offset = finish;
  }
}

function seekSequence(second) {
  if (!sequenceReady) return;
  const target = clamp(second, 0, sequencePlayer.duration);
  sequencePlayer.currentTime = target;
  updateSequenceClock(target);
}

function toggleSequence() {
  if (!sequenceReady) return;
  if (!sequencePlayer.paused) sequencePlayer.pause();
  else {
    if (sequencePlayer.ended) seekSequence(0);
    sequencePlayer.play().catch(() => status("sequence-status", "预览暂时无法播放。", true));
  }
}

function selectionTimes(index) {
  const list = ordered(active);
  if (!times.length || !list[index]) return null;
  const start = list.slice(0, index).reduce((sum, item) => sum + spanDuration(item), 0);
  return {start, end: start + spanDuration(list[index]), source: list[index].start};
}

function closeClipHover() {
  clearTimeout(hoverTimer);
  hoveredClip = null;
  hoverPlayer.pause();
  byId("segment-hover").hidden = true;
}

function hoverSelected(index, card) {
  closeClipHover();
  if (stage !== 2 || !sequenceReady || dragIndex !== null) return;
  hoverTimer = setTimeout(() => {
    const range = selectionTimes(index);
    if (!range || !card.isConnected || !sequenceReady) return;
    hoveredClip = {...range, end: Math.min(range.end, sequencePlayer.duration)};
    const target = hoveredClip;
    const popup = byId("segment-hover");
    const bounds = card.getBoundingClientRect();
    const height = Math.min(230, 155 * sequencePlayer.videoHeight / sequencePlayer.videoWidth);
    const width = Math.min(210, height * sequencePlayer.videoWidth / sequencePlayer.videoHeight);
    popup.style.width = `${width}px`;
    popup.style.left = `${clamp(bounds.left > width + 12 ? bounds.left - width - 8 : bounds.right - width,
                                8, window.innerWidth - width - 8)}px`;
    popup.style.top = `${clamp(bounds.top, 8, window.innerHeight - height - 12)}px`;
    const show = () => {
      if (hoveredClip !== target) return;
      hoverPlayer.currentTime = target.start;
      popup.hidden = false;
      hoverPlayer.play().catch(() => { /* The first frame still previews the selection. */ });
    };
    const source = sequencePlayer.getAttribute("src");
    if (hoverPlayer.getAttribute("src") === source && hoverPlayer.readyState >= 1) show();
    else {
      hoverPlayer.addEventListener("loadedmetadata", show, {once: true});
      hoverPlayer.src = source;
    }
  }, 210);
}

function loopHover(second) {
  if (hoveredClip && second >= hoveredClip.end - .003) {
    hoverPlayer.currentTime = hoveredClip.start;
    if (hoverPlayer.ended) hoverPlayer.play().catch(() => {});
  }
}

function hoverFrame(_now, frame) {
  if (!hoveredClip || hoverPlayer.paused) return;
  loopHover(frame.mediaTime);
  hoverPlayer.requestVideoFrameCallback(hoverFrame);
}

hoverPlayer.addEventListener("play", () => hoverPlayer.requestVideoFrameCallback?.(hoverFrame));
hoverPlayer.addEventListener("timeupdate", () => {
  if (!hoverPlayer.requestVideoFrameCallback) loopHover(hoverPlayer.currentTime);
});
hoverPlayer.addEventListener("ended", () => loopHover(hoverPlayer.duration));
window.addEventListener("scroll", closeClipHover, {passive: true});
window.addEventListener("resize", closeClipHover);

function previewSelected(index, play = true) {
  if (stage !== 2) return;
  const range = selectionTimes(index);
  if (!range) return;
  closeClipHover();
  seekFrame(range.source);
  if (!sequenceReady) {
    pendingSequenceClip = {index, play};
    return;
  }
  sequencePlayer.pause();
  sequenceLimit = play ? {start: range.start, end: Math.min(range.end, sequencePlayer.duration)} : null;
  seekSequence(range.start);
  if (play) sequencePlayer.play().catch(() => status("sequence-status", "已定位到选段。点播放即可预览。"));
}

function finishSequenceClip(second) {
  if (!sequenceLimit || second < sequenceLimit.end - .0005) return false;
  const {start, end} = sequenceLimit;
  sequenceLimit = null;
  sequencePlayer.pause();
  seekSequence(Math.max(start, end - .017));
  return true;
}

let sequenceWatch = null;

function watchSequence(_now, media) {
  sequenceWatch = null;
  if (!sequencePlayer.paused && !finishSequenceClip(media.mediaTime)) {
    sequenceWatch = sequencePlayer.requestVideoFrameCallback(watchSequence);
  }
}

sequencePlayer.addEventListener("play", () => {
  byId("sequence-play").textContent = "暂停";
  player.pause();
  if (sequencePlayer.requestVideoFrameCallback && sequenceWatch === null) {
    sequenceWatch = sequencePlayer.requestVideoFrameCallback(watchSequence);
  }
});
sequencePlayer.addEventListener("pause", () => {
  byId("sequence-play").textContent = "播放";
  if (sequenceWatch !== null) {
    sequencePlayer.cancelVideoFrameCallback(sequenceWatch);
    sequenceWatch = null;
  }
});
sequencePlayer.addEventListener("ended", () => {
  sequenceLimit = null;
  byId("sequence-play").textContent = "播放";
});
for (const event of ["timeupdate", "seeked"]) sequencePlayer.addEventListener(event, () => {
  if (!sequencePlayer.requestVideoFrameCallback && !sequencePlayer.paused) finishSequenceClip(sequencePlayer.currentTime);
  updateSequenceClock();
});
sequenceProgress.addEventListener("input", () => {
  sequenceLimit = null;
  seekSequence(Number(sequenceProgress.value));
});
for (const [id, seconds] of [["sequence-back", -3], ["sequence-forward", 3]]) {
  byId(id).addEventListener("click", () => {
    sequenceLimit = null;
    seekSequence(sequencePlayer.currentTime + seconds);
  });
}
byId("sequence-speed").addEventListener("change", (event) => {
  sequencePlayer.playbackRate = Number(event.target.value);
});
byId("sequence-play").addEventListener("click", toggleSequence);
sequencePlayer.addEventListener("click", toggleSequence);
player.addEventListener("play", () => sequencePlayer.pause());

function setIn() {
  if (stage !== 2 || !active || !times.length || saving) return;
  if (pending.has(active.id)) {
    pending.delete(active.id);
    updateCursor(frameIndex);
    paintRanges();
    status("editor-status", "已取消入点。");
    return;
  }
  if (!player.paused) seekFrame(visibleFrame(player.currentTime));
  pending.set(active.id, frameIndex);
  updateCursor(frameIndex);
  status("editor-status");
}

async function setOut() {
  if (stage !== 2 || !active || !times.length || saving || !pending.has(active.id)) return;
  if (!player.paused) seekFrame(visibleFrame(player.currentTime));
  const start = pending.get(active.id);
  if (frameIndex < start) {
    status("editor-status", "出点在入点前面。把时间轴移到入点之后。", true);
    return;
  }
  const video = active;
  const segment = {start, end: frameIndex};
  const list = [...ordered(video), segment];
  const inOrder = video.manualOrder ? list : sortByTimeline(list);
  const offset = inOrder.slice(0, inOrder.indexOf(segment)).reduce((sum, item) => sum + spanDuration(item), 0);
  if (!await saveSegments(video, inOrder, Boolean(video.manualOrder), offset)) return;
  pending.delete(video.id);
  if (active === video) {
    updateCursor(frameIndex);
    paintRanges();
    status("editor-status", "选段已保存。可继续设下一个入点。");
  }
}

async function saveSegments(video, segments, manualOrder = Boolean(video?.manualOrder), offset = 0) {
  if (stage !== 2 || saving || !video) return false;
  saving = true;
  drawNavigation();
  byId("mark-out").disabled = true;
  fineMark.disabled = true;
  try {
    const result = await api(videoAPI(video, "segments"), {segments, manualOrder});
    video.segments = result.segments;
    video.manualOrder = result.manualOrder;
    drawLibrary();
    if (video === active) {
      drawSegments();
      queueSequence(offset);
    }
    return true;
  } catch (error) {
    status("editor-status", error.message, true);
    return false;
  } finally {
    saving = false;
    drawNavigation();
    drawJob();
    if (times.length) updateCursor(frameIndex);
    byId("reset-order").disabled = false;
  }
}

function closeFineWindow() {
  clearTimeout(fineTimer);
  fineWindow = null;
  if (slowUntil !== null) {
    player.pause();
    endSlowPreview();
  }
  finePanel.hidden = true;
  track.classList.remove("scrubbing-fine");
}

function resetFineInteraction() {
  const pointer = mainDrag?.pointer;
  mainDrag = null;
  scrubIndex = null;
  if (scrubAnimation) cancelAnimationFrame(scrubAnimation);
  scrubAnimation = 0;
  if (pointer !== undefined && track.hasPointerCapture(pointer)) track.releasePointerCapture(pointer);
  closeFineWindow();
}

function paintFineCursor() {
  if (!fineWindow) return;
  const {start, end} = fineWindow;
  const second = clamp(times[frameIndex], start, end);
  fineInput.value = second;
  byId("fine-time").textContent = `${asTime(second)} 秒`;
  byId("fine-playhead").style.left = `${(second - start) / (end - start) * 100}%`;
}

function openFineWindow(drag) {
  if (mainDrag !== drag || stage !== 2 || times.length < 2) return;
  const lastSecond = times.at(-1);
  const width = Math.min(lastSecond, 3, Math.max(.5, lastSecond * .25));
  const anchor = times[drag.index];
  const beginning = clamp(anchor - width / 2, 0, lastSecond - width);
  const first = Math.min(nearestFrame(beginning), times.length - 2);
  const last = Math.max(first + 1, nearestFrame(beginning + width));
  const start = times[first];
  const end = times[last];
  if (end <= start) return;

  const origin = track.getBoundingClientRect();
  const panel = byId("controls");
  const panelWidth = Math.min(panel.clientWidth, 510);
  const fraction = (anchor - start) / (end - start);
  const left = clamp(drag.x - origin.left - fraction * panelWidth, 0, panel.clientWidth - panelWidth);
  fineWindow = {start, end, anchor, x: drag.x};
  finePanel.style.left = `${left}px`;
  fineInput.min = String(start);
  fineInput.max = String(end);
  byId("fine-start").textContent = `${asTime(start)} 秒`;
  byId("fine-end").textContent = `${asTime(end)} 秒`;
  finePanel.hidden = false;
  finePanel.style.top = `${track.offsetTop - finePanel.offsetHeight + 2}px`;
  paintFineCursor();

  // The stills are navigation landmarks. Actual scrubbing uses the source player.
  const current = fineWindow;
  const image = byId("fine-images");
  const source = `${videoAPI(active, "fine")}?first=${first}&last=${last}`;
  image.hidden = true;
  const thumb = new Image();
  thumb.onload = () => {
    if (fineWindow !== current) return;
    image.src = source;
    image.hidden = false;
  };
  thumb.src = source;
}

function coarseFrame(x) {
  const bounds = track.getBoundingClientRect();
  const ratio = clamp((x - bounds.left) / bounds.width, 0, 1);
  return Math.round(ratio * (times.length - 1));
}

function queueScrub(index) {
  scrubIndex = index;
  if (scrubAnimation) return;
  scrubAnimation = requestAnimationFrame(() => {
    scrubAnimation = 0;
    const next = scrubIndex;
    scrubIndex = null;
    if (next !== null && next !== frameIndex) seekFrame(next, false);
  });
}

function settleFineWindow(drag) {
  clearTimeout(fineTimer);
  fineTimer = setTimeout(() => openFineWindow(drag), 350);
}

function beginMainDrag(event) {
  if (stage !== 2 || !times.length || event.button !== 0 || mainDrag) return;
  event.preventDefault();
  resetFineInteraction();
  timeline.focus({preventScroll: true});
  track.setPointerCapture(event.pointerId);
  mainDrag = {pointer: event.pointerId, x: event.clientX, index: coarseFrame(event.clientX), fine: false};
  seekFrame(mainDrag.index, false);
  settleFineWindow(mainDrag);
}

function moveMainDrag(event) {
  const drag = mainDrag;
  if (drag?.pointer !== event.pointerId) return;
  const trackTop = track.getBoundingClientRect().top;
  if (fineWindow && event.clientY < trackTop) {
    drag.fine = true;
    track.classList.add("scrubbing-fine");
    const rail = fineInput.getBoundingClientRect();
    const window = fineWindow;
    const delta = event.clientX - window.x;
    const proportion = delta < 0 ? (window.anchor - window.start) / Math.max(12, window.x - rail.left)
      : (window.end - window.anchor) / Math.max(12, rail.right - window.x);
    drag.index = nearestFrame(clamp(window.anchor + delta * proportion, window.start, window.end));
    queueScrub(drag.index);
    return;
  }
  if (drag.fine && event.clientY < trackTop + 9) return;
  if (drag.fine || Math.abs(event.clientX - drag.x) >= 3) {
    drag.fine = false;
    drag.x = event.clientX;
    drag.index = coarseFrame(event.clientX);
    closeFineWindow();
    queueScrub(drag.index);
    settleFineWindow(drag);
  }
}

function finishMainDrag(event) {
  const drag = mainDrag;
  if (drag?.pointer !== event.pointerId) return;
  if (scrubAnimation) cancelAnimationFrame(scrubAnimation);
  scrubAnimation = 0;
  scrubIndex = null;
  mainDrag = null;
  clearTimeout(fineTimer);
  track.classList.remove("scrubbing-fine");
  seekFrame(drag.index);
}

track.addEventListener("pointerdown", beginMainDrag);
track.addEventListener("pointermove", moveMainDrag);
for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) {
  track.addEventListener(event, finishMainDrag);
}

fineInput.addEventListener("input", () => seekFrame(nearestFrame(Number(fineInput.value))));
function endSlowPreview() {
  if (slowUntil === null) return;
  slowUntil = null;
  player.playbackRate = 1;
  byId("fine-slow").textContent = "慢放";
}

byId("fine-slow").addEventListener("click", () => {
  if (!fineWindow) return;
  if (slowUntil !== null) {
    player.pause();
    endSlowPreview();
    return;
  }
  const {start, end} = fineWindow;
  const current = times[frameIndex];
  if (current < start || current >= end - .025) seekFrame(nearestFrame(start));
  slowUntil = end;
  player.playbackRate = Number(byId("fine-speed").value);
  byId("fine-slow").textContent = "暂停慢放";
  player.play().catch(() => endSlowPreview());
});
byId("fine-speed").addEventListener("change", (event) => {
  if (slowUntil !== null) player.playbackRate = Number(event.target.value);
});
fineMark.addEventListener("click", () => {
  if (active && pending.has(active.id)) setOut();
  else setIn();
});
document.addEventListener("pointerdown", (event) => {
  if (!mainDrag && !track.contains(event.target) && !finePanel.contains(event.target)) closeFineWindow();
});

const linkPattern = /https?:\/\/(?:v\.douyin\.com\/[\w-]+\/?|(?:www\.)?(?:douyin\.com\/video|iesdouyin\.com\/share\/video)\/[1-9]\d{15,19})/g;
const extractLinks = (value) => value.replace(/\\(?=[:/])/g, "").match(linkPattern) ?? [];
const newRow = (value = "") => ({value, status: "ready", title: "", error: ""});
const storageKey = "shotdesk-link-table-v1";
let linkRows;
try {
  const previous = JSON.parse(localStorage.getItem(storageKey));
  linkRows = Array.isArray(previous) && previous.length ? previous.map((row) => ({
    ...newRow(), ...row, status: row.status === "running" ? "ready" : row.status,
  })) : [newRow()];
} catch {
  linkRows = [newRow()];
}

function saveRows() {
  try { localStorage.setItem(storageKey, JSON.stringify(linkRows)); } catch { /* The current page still works. */ }
}

function drawImportCount() {
  const count = linkRows.filter((row) => row.value.trim()).length;
  byId("link-count").textContent = count;
  byId("import-all").disabled = importing || !linkRows.some((row) => row.value.trim() && !["done", "cached"].includes(row.status));
}

function replaceRow(index, links) {
  linkRows.splice(index, 1, ...links.map(newRow));
  saveRows();
  drawImport();
}

function drawImport() {
  const tbody = byId("link-rows");
  tbody.replaceChildren();
  for (const [index, row] of linkRows.entries()) {
    const tr = node("tr");
    const input = node("textarea");
    input.rows = 1;
    input.value = row.value;
    input.placeholder = "粘贴链接或分享文案";
    input.setAttribute("aria-label", `第 ${index + 1} 行链接`);
    input.disabled = importing;
    input.addEventListener("paste", (event) => {
      const links = extractLinks(event.clipboardData?.getData("text/plain") || "");
      if (!links.length) return;
      event.preventDefault();
      replaceRow(index, links);
      tbody.querySelectorAll("textarea")[index + links.length - 1]?.focus();
    });
    input.addEventListener("input", () => {
      row.value = input.value;
      row.status = "ready";
      row.title = "";
      row.error = "";
      title.textContent = "—";
      feedback.textContent = row.value.trim() ? "待下载" : "—";
      feedback.className = "muted";
      action.textContent = "下载";
      action.disabled = !row.value.trim();
      saveRows();
      drawImportCount();
    });
    const value = node("td");
    value.append(input);
    const title = node("td", "", row.title || "—");
    const statuses = {ready: row.value.trim() ? "待下载" : "—", running: "下载中", done: "已下载",
                      cached: "已在素材库", error: row.error || "下载失败"};
    const feedback = node("td", row.status === "error" ? "errors" : "muted", statuses[row.status]);
    const actions = node("td");
    const actionList = node("div");
    const action = smallButton(row.status === "error" ? "重试" : "下载", () => importRows([row]), "bare");
    const remove = smallButton("移除", () => {
      linkRows.splice(index, 1);
      if (!linkRows.length) linkRows.push(newRow());
      saveRows();
      drawImport();
    }, "bare");
    action.disabled = importing || !row.value.trim() || ["done", "cached"].includes(row.status);
    remove.disabled = importing;
    actionList.append(action, remove);
    actions.append(actionList);
    tr.append(value, title, feedback, actions);
    tbody.append(tr);
  }
  byId("add-link").disabled = importing;
  drawImportCount();
}

async function importRows(rows) {
  if (stage !== 1 || importing) return;
  const queue = [];
  for (const row of rows) {
    if (!row.value.trim() || ["done", "cached"].includes(row.status)) continue;
    const links = extractLinks(row.value);
    if (!links.length) {
      row.status = "error";
      row.error = "没找到抖音视频链接。";
      continue;
    }
    row.value = links[0];
    queue.push(row);
    if (links.length > 1) {
      const more = links.slice(1).map(newRow);
      linkRows.splice(linkRows.indexOf(row) + 1, 0, ...more);
      queue.push(...more);
    }
  }
  importing = true;
  drawNavigation();
  let imported = 0;
  let cached = 0;
  for (const [index, row] of queue.entries()) {
    row.status = "running";
    drawImport();
    status("import-status", `正在下载 ${index + 1}/${queue.length}…`);
    try {
      const result = await api("/api/import", {link: row.value});
      let video = videos.find((item) => item.id === result.video.id);
      if (!video) {
        video = result.video;
        videos.push(video);
      }
      row.title = video.title;
      row.status = result.cached ? "cached" : "done";
      if (result.cached) cached++;
      else imported++;
      drawLibrary();
      if (stage === 2 && !active) selectVideo(video);
    } catch (error) {
      row.status = "error";
      row.error = error.message;
    }
    saveRows();
  }
  importing = false;
  const failed = linkRows.filter((row) => row.status === "error").length;
  status("import-status", `新增 ${imported} 条，重复 ${cached} 条${failed ? `，失败 ${failed} 条` : ""}。`);
  saveRows();
  drawImport();
  drawNavigation();
}

function currentResult() {
  const mode = chosenMode();
  const available = jobsFor(active);
  const matching = available.filter((job) => sameSelection(job.selection, ordered(active)));
  return matching.findLast((job) => job.mode === mode && sameProduct(job))
    || available.findLast((job) => job.mode === mode && sameProduct(job))
    || available.findLast((job) => job.status === "done");
}

function drawJob() {
  if (stage !== 3) return;
  const job = currentResult();
  const mode = chosenMode();
  const allMode = byId("all-mode").value;
  const old = job && (!sameSelection(job.selection, ordered(active)) || job.mode !== mode || !sameProduct(job));
  byId("result-title").textContent = active ? active.title : "导出与提示词";
  const needsProduct = replacing() && !replacement;
  byId("generate").disabled = needsProduct || !active?.segments.length || busyForMode(active, mode) || enqueuing;
  byId("generate-all").disabled = needsProduct || enqueuing || !videos.some((video) => video.segments.length
    && !busyForMode(video, allMode) && !completeForMode(video, allMode));
  status("job-status", job ? (old ? "这是上一次结果。当前选段、生成方式或产品已调整。" : job.message)
    : "选择生成方式后即可导出。", job?.status === "error" && !old);
  const stamp = JSON.stringify([job?.id, job?.status, job?.entries, job?.exportJob]);
  if (resultStamp === stamp) return;
  resultStamp = stamp;
  const result = byId("result");
  result.replaceChildren();
  result.hidden = !job || (!job.entries.length && !job.exportJob);
  if (result.hidden) return;

  if (job.exportJob) {
    const download = userDownload("下载拼接 MP4", `/api/jobs/${job.exportJob}/montage.mp4`, `${active.title}-拼接.mp4`);
    download.className = "result-download";
    result.append(download);
  }
  if (job.status === "done") {
    const download = userDownload("下载提示词", jobFile(job, "prompts.md"), "Seedance提示词.md");
    download.className = "result-download";
    result.append(download);
  }
  const cards = node("div", "result-list");
  for (const entry of job.entries) {
    if (!entry.prompt) continue;
    const card = node("details", "prompt-card");
    card.open = true;
    const fps = active.avg_frame_rate?.split("/").map(Number) ?? [30, 1];
    const duration = entry.duration ?? ((entry.end ?? 0) - (entry.start ?? 0) + (fps[1] / fps[0]));
    card.append(node("summary", "mono", `${asTime(duration)} 秒`), node("p", "", entry.prompt));
    const actions = node("div", "segment-actions");
    const copy = smallButton("复制提示词", async () => {
      try {
        await navigator.clipboard.writeText(entry.prompt);
        copy.textContent = "已复制";
        setTimeout(() => { copy.textContent = "复制提示词"; }, 1200);
      } catch {
        status("job-status", "可以选中文字复制，或下载提示词。", true);
      }
    });
    actions.append(copy);
    card.append(actions);
    cards.append(card);
  }
  result.append(cards);
}

async function refreshJobs() {
  const activeJobs = [...jobs.values()].filter(running);
  if (!activeJobs.length) return;
  const data = await Promise.allSettled(activeJobs.map((job) => api(`/api/jobs/${job.id}`)));
  for (const outcome of data) {
    if (outcome.status === "fulfilled") jobs.set(outcome.value.id, outcome.value);
  }
  drawJob();
  if (data.some((outcome) => outcome.status === "fulfilled" && !running(outcome.value))) drawLibrary();
}

async function enqueue(scope) {
  if (stage !== 3 || enqueuing || (replacing() && !replacement)) return;
  enqueuing = true;
  drawJob();
  const mode = byId(scope === "all" ? "all-mode" : "current-mode").value;
  try {
    const result = await api("/api/generate", {scope, mode, video: active?.id, productId: requestedProduct()});
    for (const job of result.jobs) jobs.set(job.id, job);
    if (scope === "all" && result.jobs.length) {
      byId("current-mode").value = mode;
      if (!result.jobs.some((job) => job.video === active?.id)) {
        active = videos.find((video) => video.id === result.jobs[0].video);
        times = [];
      }
    }
    status("workflow-status", result.jobs.length ? "" : "当前模式下没有待处理视频。");
  } catch (error) {
    status("workflow-status", error.message, true);
  } finally {
    enqueuing = false;
    drawLibrary();
    drawJob();
  }
}

function drawNavigation() {
  const back = byId("step-back");
  const next = byId("step-next");
  back.hidden = stage < 2;
  next.hidden = stage === 0 || stage === 3;
  back.disabled = changingStep;
  next.disabled = changingStep;
  back.textContent = stage === 3 ? "返回选段" : "返回导入";
  next.textContent = stage === 1 ? "下一步 · 选段" : "下一步 · 导出";
}

function displayStage() {
  for (const [number, id] of [[1, "import-step"], [2, "edit-step"], [3, "generate-step"]]) {
    byId(id).hidden = number !== stage;
    const marker = document.querySelector(`[data-step="${number}"]`);
    if (number === stage) marker.setAttribute("aria-current", "step");
    else marker.removeAttribute("aria-current");
  }
  drawNavigation();
  if (stage !== 2) {
    player.pause();
    clearSequence();
    resetFineInteraction();
  }
  if (stage === 1) drawImport();
  if (stage === 2 && videos.length) selectVideo(active ?? videos[0]);
  if (stage === 3) {
    if (!active?.segments.length) {
      active = videos.find((video) => video.segments.length) || null;
      times = [];
    }
    const last = jobsFor(active).findLast((job) => job.mode);
    if (last) byId("current-mode").value = last.mode;
    drawJob();
  }
  drawLibrary();
}

async function changeStep(target) {
  if (changingStep || stage === target || target < 1 || target > 3) return;
  changingStep = true;
  drawNavigation();
  try {
    const result = await api("/api/stage", {stage: target});
    stage = result.stage;
    status("workflow-status");
    displayStage();
    window.scrollTo(0, 0);
  } catch (error) {
    status("workflow-status", error.message, true);
  } finally {
    changingStep = false;
    drawNavigation();
  }
}

const productKey = "shotdesk-product-v1";

function drawProduct() {
  const enabled = replacing();
  const label = byId("product-active");
  byId("edit-product").hidden = !enabled;
  label.hidden = !enabled;
  label.textContent = replacement?.name || "请选择替换产品";
  drawJob();
}

function selectProduct(product) {
  replacement = product;
  try {
    sessionStorage.setItem(productKey, product.id);
  } catch { /* The current page still works. */ }
  byId("replace-product").value = "yes";
  if (productDialog.open) productDialog.close();
  drawProduct();
  drawLibrary();
}

async function openProduct() {
  const history = byId("product-history");
  history.replaceChildren(new Option("选择已保存产品", ""));
  byId("use-history").disabled = true;
  byId("product-form").reset();
  byId("product-files-list").textContent = "";
  status("product-status");
  productDialog.showModal();
  try {
    const {products} = await api("/api/products");
    for (const item of products) {
      const date = new Date(item.created).toLocaleDateString("zh-CN");
      history.add(new Option(`${item.name} · ${date}`, item.id));
    }
  } catch (error) {
    status("product-status", error.message, true);
  }
}

function readProductFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({name: file.name, data: reader.result.split(",", 2)[1]});
    reader.onerror = () => reject(new Error(`无法读取 ${file.name}。`));
    reader.readAsDataURL(file);
  });
}

async function submitProduct(save) {
  if (productBusy) return;
  const files = [...byId("product-files").files];
  if (files.length > 8 || files.some((file) => file.size > 8 * 1024 ** 2)
      || files.reduce((sum, file) => sum + file.size, 0) > 24 * 1024 ** 2) {
    status("product-status", "最多 8 个附件，每个 8 MB，合计 24 MB。", true);
    return;
  }
  const name = byId("product-name").value.trim();
  if (!name) {
    status("product-status", "先填写新产品名。", true);
    byId("product-name").focus();
    return;
  }
  const notes = byId("product-notes").value;
  productBusy = true;
  for (const id of ["save-product", "use-product", "close-product", "use-history"]) byId(id).disabled = true;
  status("product-status", "正在读取产品资料…");
  try {
    const attachments = await Promise.all(files.map(readProductFile));
    selectProduct(await api("/api/products", {name, notes, files: attachments, save}));
  } catch (error) {
    status("product-status", error.message, true);
  } finally {
    productBusy = false;
    for (const id of ["save-product", "use-product", "close-product"]) byId(id).disabled = false;
    byId("use-history").disabled = !byId("product-history").value;
  }
}

byId("replace-product").addEventListener("change", () => {
  drawProduct();
  drawLibrary();
  if (replacing()) openProduct();
  else {
    try { sessionStorage.removeItem(productKey); } catch {}
  }
});
byId("edit-product").addEventListener("click", openProduct);
byId("close-product").addEventListener("click", () => productDialog.close());
productDialog.addEventListener("cancel", (event) => {
  if (productBusy) event.preventDefault();
});
productDialog.addEventListener("close", () => {
  if (!replacement) byId("replace-product").value = "no";
  drawProduct();
});
byId("product-history").addEventListener("change", (event) => {
  byId("use-history").disabled = productBusy || !event.target.value;
});
byId("use-history").addEventListener("click", async () => {
  try {
    selectProduct(await api(`/api/products/${byId("product-history").value}`));
  } catch (error) {
    status("product-status", error.message, true);
  }
});
byId("product-files").addEventListener("change", (event) => {
  byId("product-files-list").textContent = [...event.target.files].map((file) => file.name).join("、");
});
byId("product-form").addEventListener("submit", (event) => {
  event.preventDefault();
  submitProduct(true);
});
byId("use-product").addEventListener("click", () => submitProduct(false));
try {
  const savedProductId = sessionStorage.getItem(productKey);
  if (savedProductId) api(`/api/products/${savedProductId}`).then(selectProduct).catch(() => {});
} catch { /* The current page still works. */ }

byId("add-link").addEventListener("click", () => {
  linkRows.push(newRow());
  saveRows();
  drawImport();
  byId("link-rows").querySelector("tr:last-child textarea")?.focus();
});
byId("import-all").addEventListener("click", () => importRows([...linkRows]));
for (const button of document.querySelectorAll("[data-step]")) {
  button.addEventListener("click", () => changeStep(Number(button.dataset.step)));
}
byId("step-back").addEventListener("click", () => changeStep(stage - 1));
byId("step-next").addEventListener("click", () => changeStep(stage + 1));
byId("next-video").addEventListener("click", () => {
  const next = videos[videos.indexOf(active) + 1];
  if (next) selectVideo(next);
});
byId("play").addEventListener("click", togglePlayback);
byId("back-frame").addEventListener("click", () => seekFrame(frameIndex - 1));
byId("forward-frame").addEventListener("click", () => seekFrame(frameIndex + 1));
timeline.addEventListener("input", () => seekFrame(Number(timeline.value)));
byId("mark-in").addEventListener("click", setIn);
byId("mark-out").addEventListener("click", setOut);
byId("reset-order").addEventListener("click", () => saveSegments(active, sortByTimeline(ordered(active)), false));
byId("generate").addEventListener("click", () => enqueue("current"));
byId("generate-all").addEventListener("click", () => enqueue("all"));
byId("current-mode").addEventListener("change", () => { drawLibrary(); drawJob(); });
byId("all-mode").addEventListener("change", drawJob);
document.addEventListener("keydown", (event) => {
  if (stage !== 2) return;
  if (event.key === "Escape") resetFineInteraction();
  if (!times.length || event.altKey || event.metaKey || event.ctrlKey
      || event.target.closest("input:not(#timeline), textarea, button, a, select, summary, [contenteditable]")) return;
  const key = event.key.toLowerCase();
  const actions = {arrowleft: () => seekFrame(frameIndex - 1), arrowright: () => seekFrame(frameIndex + 1),
                   i: setIn, o: setOut, " ": togglePlayback};
  if (actions[key]) {
    event.preventDefault();
    actions[key]();
  }
});
setInterval(refreshJobs, 1300);

api("/api/videos").then((data) => {
  videos = data.videos;
  for (const job of data.jobs) jobs.set(job.id, job);
  stage = data.stage;
  displayStage();
}).catch((error) => status("workflow-status", error.message, true));
