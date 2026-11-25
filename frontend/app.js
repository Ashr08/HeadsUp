/* HeadsUp frontend prototype. The API routes below follow the hackathon team's FastAPI contract.
   Streaming sign-in needs separate Spotify/Apple OAuth setup; see README.md. */
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const API_KEY = "headsupApiBase";
let apiBase = localStorage.getItem(API_KEY) || "http://localhost:8000";
let listening = false;
let stream = null;
let audioContext = null;
let processor = null;
let muteGain = null;
let ring = new Float32Array(16000);
let ringCursor = 0;
let samplesSincePrediction = 0;
let filledSamples = 0;
let predictionBusy = false;
let lastAlertAt = 0;
let lastAlertSound = "";
let teachRecordStream = null;
let teachRecorder = null;
let teachChunks = [];
let activeRecordIndex = -1;
let customSamples = [];
let toastTimer;
const settings = JSON.parse(localStorage.getItem("headsupSettings") || "{}");
const customNames = new Set();
const DEFAULT_THRESHOLDS = {alarm:78, knock:52, car_horn:88, dog_bark:58, glass_breaking:82};

// Navigation between the four pages shown in the design references.
function goTo(page) {
  $$(".page").forEach(section => section.classList.toggle("page-active", section.dataset.page === page));
  $$(".nav-item").forEach(button => button.classList.toggle("active", button.dataset.nav === page));
  history.replaceState(null, "", `#${page}`);
  window.scrollTo({top:0, behavior:"smooth"});
}
$$('[data-nav]').forEach(button => button.addEventListener("click", () => goTo(button.dataset.nav)));
$$('[data-go]').forEach(button => button.addEventListener("click", () => goTo(button.dataset.go)));

function showToast(message) {
  const toast = $("#toast"); toast.textContent = message; toast.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove("show"), 3000);
}
function normalizeBase(value) { return value.trim().replace(/\/+$/, ""); }
function api(path) { return `${apiBase}${path}`; }
async function checkBackend() {
  const status = $("#backendStatus");
  try {
    const response = await fetch(api("/health"), {signal:AbortSignal.timeout(2500)});
    if (!response.ok) throw new Error("Backend unavailable");
    const data = await response.json();
    status.classList.remove("offline"); status.querySelector("span").textContent = data.model ? `Backend connected · ${data.model}` : "Backend connected";
    $("#micPermission").innerHTML = '<span class="status-dot"></span> Microphone permission is requested when listening starts.';
    return true;
  } catch {
    status.classList.add("offline"); status.querySelector("span").textContent = "Backend offline";
    return false;
  }
}
checkBackend();

// Settings persist locally in this prototype; account sync requires the auth service.
function persistSettings() { localStorage.setItem("headsupSettings", JSON.stringify(settings)); }
$$('[data-setting]').forEach(input => {
  if (settings[input.dataset.setting] !== undefined) input.checked = settings[input.dataset.setting];
  input.addEventListener("change", () => { settings[input.dataset.setting] = input.checked; persistSettings(); });
});
$$('[data-sound-toggle]').forEach(input => {
  const key = `sound_${input.dataset.sound}`;
  if (settings[key] !== undefined) input.checked = settings[key];
  input.addEventListener("change", () => { settings[key] = input.checked; persistSettings(); });
});
$$('[data-threshold]').forEach(input => {
  const key = `threshold_${input.dataset.threshold}`;
  if (settings[key] !== undefined) input.value = settings[key];
  input.addEventListener("input", () => { settings[key] = Number(input.value); persistSettings(); });
});
const savedTheme = localStorage.getItem("headsupTheme") || "light";
$$('[name="theme"]').forEach(input => {
  input.checked = input.value === savedTheme;
  input.addEventListener("change", () => {
    if (!input.checked) return;
    localStorage.setItem("headsupTheme", input.value);
    const dark = input.value === "dark" || (input.value === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.body.classList.toggle("dark", dark);
  });
});
if (savedTheme === "dark" || (savedTheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)) document.body.classList.add("dark");

// Provider buttons intentionally stop before authentication until OAuth credentials and callback routes exist.
const providerModal = $("#providerModal");
$$('.provider-connect').forEach(button => button.addEventListener("click", () => {
  const provider = button.dataset.provider;
  $("#providerModalTitle").textContent = `Connect ${provider === "spotify" ? "Spotify" : "Apple Music"}`;
  $("#providerModalText").textContent = `To sign in with ${provider === "spotify" ? "Spotify" : "Apple Music"}, the project needs registered developer credentials and a secure OAuth callback. The app should redirect you to the provider; it should never collect your music password.`;
  providerModal.showModal();
}));
$("#providerModalAction").addEventListener("click", () => providerModal.close());
$("#disconnectMusic").addEventListener("click", () => {
  $("#connectedPlayer").classList.add("hidden"); $("#providerGrid").classList.remove("hidden");
  showToast("Music service disconnected.");
});

// Account UI: submits to an expected route but does not pretend signup works without a backend.
const signupModal = $("#signupModal");
$("#openSignup").addEventListener("click", () => signupModal.showModal());
$("#accountSettings").addEventListener("click", () => signupModal.showModal());
$("#signupForm").addEventListener("submit", async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const response = await fetch(api("/auth/signup"), {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({name:form.get("name"), email:form.get("email")})});
    if (!response.ok) throw new Error();
    const data = await response.json();
    const name = data.name || form.get("name");
    $("#accountName").textContent = name; $("#accountChip").classList.remove("hidden"); $("#openSignup").classList.add("hidden");
    signupModal.close(); showToast("Account created.");
  } catch { showToast("Signup needs the /auth/signup backend route."); }
});

// Browser microphone capture: 16 kHz mono, 16-bit PCM WAV, 1 s overlapping windows to POST /predict.
function floatToWav(floatSamples, sampleRate = 16000) {
  const buffer = new ArrayBuffer(44 + floatSamples.length * 2);
  const view = new DataView(buffer);
  const writeText = (offset, text) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  writeText(0, "RIFF"); view.setUint32(4, 36 + floatSamples.length * 2, true); writeText(8, "WAVE");
  writeText(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeText(36, "data"); view.setUint32(40, floatSamples.length * 2, true);
  let offset = 44;
  for (const sample of floatSamples) { const value = Math.max(-1, Math.min(1, sample)); view.setInt16(offset, value < 0 ? value * 32768 : value * 32767, true); offset += 2; }
  return new Blob([buffer], {type:"audio/wav"});
}
async function sendPrediction() {
  if (predictionBusy || !listening || filledSamples < 16000) return;
  predictionBusy = true;
  const frame = new Float32Array(16000);
  for (let i=0; i<16000; i++) frame[i] = ring[(ringCursor + i) % 16000];
  const data = new FormData(); data.append("audio", floatToWav(frame), "heads-up.wav");
  try {
    const response = await fetch(api("/predict"), {method:"POST", body:data});
    if (!response.ok) throw new Error(`Prediction request failed (${response.status})`);
    const result = await response.json(); renderPrediction(result);
  } catch (error) { showToast("Could not reach /predict. Check the backend URL."); console.warn(error); }
  finally { predictionBusy = false; }
}
function renderPrediction(result) {
  const all = result.all || {};
  $$(".confidence-row").forEach(row => {
    const name = row.dataset.sound; const raw = Number(all[name] ?? (result.top === name ? result.confidence : 0));
    const pct = Math.max(0, Math.min(100, raw <= 1 ? raw * 100 : raw));
    row.querySelector("b").textContent = `${Math.round(pct)}%`; row.querySelector(".bar-fill").style.width = `${pct}%`;
  });
  const sound = result.custom_match?.name || result.top;
  const confidence = Number(result.custom_match?.similarity ?? result.confidence ?? all[sound] ?? 0);
  const pct = confidence <= 1 ? confidence * 100 : confidence;
  const enabled = $(`[data-sound-toggle="${CSS.escape(sound)}"]`);
  const thresholdInput = $(`[data-threshold="${CSS.escape(sound)}"]`);
  const threshold = Number(thresholdInput?.value ?? DEFAULT_THRESHOLDS[sound] ?? 70);
  const isEnabled = enabled ? enabled.checked : customNames.has(sound);
  if (!sound || !isEnabled || pct < threshold || sound === "background") return;
  const now = Date.now();
  if (now-lastAlertAt < 5000 && sound === lastAlertSound) return;
  lastAlertAt = now; lastAlertSound = sound;
  const pretty = sound.replaceAll("_", " ").replace(/\b\w/g, char => char.toUpperCase());
  $("#alertSoundName").textContent = pretty;
  $("#alertConfidence").textContent = settings.showConfidence === false ? "Sound matched" : `${Math.round(pct)}% confidence`;
  if (settings.pauseMusic !== false) $("#alertModal").showModal();
  else showToast(`${pretty} detected · ${Math.round(pct)}%`);
}
async function startListening() {
  if (!window.isSecureContext && location.hostname !== "localhost") { showToast("Microphone access needs HTTPS or localhost."); return; }
  try {
    const audioConstraints = {channelCount:1, echoCancellation:false, noiseSuppression:false, autoGainControl:false};
    if (settings.micDevice) audioConstraints.deviceId = {exact:settings.micDevice};
    stream = await navigator.mediaDevices.getUserMedia({audio:audioConstraints});
    audioContext = new (window.AudioContext || window.webkitAudioContext)({sampleRate:16000});
    if (audioContext.sampleRate !== 16000) console.warn("AudioContext is", audioContext.sampleRate, "Hz; browser may resample the input.");
    const source = audioContext.createMediaStreamSource(stream);
    processor = audioContext.createScriptProcessor(4096, 1, 1);
    muteGain = audioContext.createGain(); muteGain.gain.value = 0;
    ring = new Float32Array(16000); ringCursor = 0; filledSamples = 0; samplesSincePrediction = 0;
    processor.onaudioprocess = event => {
      if (!listening) return;
      const input = event.inputBuffer.getChannelData(0);
      for (let i=0; i<input.length; i++) {
        ring[ringCursor] = input[i]; ringCursor = (ringCursor + 1) % ring.length;
        filledSamples = Math.min(16000, filledSamples + 1); samplesSincePrediction++;
      }
      if (filledSamples >= 16000 && samplesSincePrediction >= 8000) { samplesSincePrediction = 0; sendPrediction(); }
    };
    source.connect(processor); processor.connect(muteGain); muteGain.connect(audioContext.destination);
    listening = true;
    $("#listenToggle").classList.add("listening"); $("#listenToggle").setAttribute("aria-pressed", "true"); $("#listenButtonText").textContent = "Stop listening";
    $("#listenStatus").classList.add("active"); $("#listenStatus").innerHTML = '<span class="status-dot"></span><span>Listening · microphone is on</span>';
    $("#micPermission").innerHTML = '<span class="status-dot"></span> Microphone access granted';
    await loadMicrophones();
  } catch (error) { showToast(error.name === "NotAllowedError" ? "Allow microphone access in your browser to start listening." : "Could not start microphone capture."); }
}
async function stopListening() {
  listening = false;
  if (processor) { processor.disconnect(); processor.onaudioprocess = null; processor = null; }
  if (muteGain) { muteGain.disconnect(); muteGain = null; }
  if (stream) { stream.getTracks().forEach(track => track.stop()); stream = null; }
  if (audioContext) { await audioContext.close(); audioContext = null; }
  $("#listenToggle").classList.remove("listening"); $("#listenToggle").setAttribute("aria-pressed", "false"); $("#listenButtonText").textContent = "Start listening";
  $("#listenStatus").classList.remove("active"); $("#listenStatus").innerHTML = '<span class="status-dot"></span><span>Listening is off · microphone is not active</span>';
}
$("#listenToggle").addEventListener("click", () => listening ? stopListening() : startListening());
$("#dismissAlert").addEventListener("click", () => $("#alertModal").close());

// Microphone selector for Settings.
async function loadMicrophones() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const select = $("#micDevice"); const chosen = select.value;
    select.innerHTML = '<option value="">Default microphone</option>';
    devices.filter(device => device.kind === "audioinput").forEach((device, i) => {
      const option = document.createElement("option"); option.value = device.deviceId; option.textContent = device.label || `Microphone ${i+1}`; select.append(option);
    });
    if (chosen) select.value = chosen;
  } catch {}
}
$("#micDevice").addEventListener("change", () => { settings.micDevice = $("#micDevice").value; persistSettings(); });
loadMicrophones();

// Settings: configurable backend URL.
$("#apiBaseInput").value = apiBase;
$("#saveApiBase").addEventListener("click", async () => {
  const value = normalizeBase($("#apiBaseInput").value);
  try { new URL(value); } catch { showToast("Enter a valid backend URL."); return; }
  apiBase = value; localStorage.setItem(API_KEY, apiBase); await checkBackend(); await loadCustomSounds(); showToast("Backend URL saved.");
});

// Custom sound UI and API routes from the team's plan.
function renderCustomSound(name) {
  const list = $("#customSoundsList");
  if (list.querySelector(".empty-inline")) list.innerHTML = "";
  const safe = name.replaceAll("_", " ");
  const row = document.createElement("article"); row.className = "custom-sound-row"; row.dataset.customSound = name;
  row.innerHTML = `<div class="sound-icon"><svg class="icon"><use href="#i-wave" /></svg></div><div class="sound-details"><strong></strong><small>Custom sound taught by you.</small></div><label class="switch"><input type="checkbox" checked><span></span></label><div class="sensitivity"><span>Low</span><input type="range" min="20" max="95" value="55" aria-label="${safe} sensitivity"><span>High</span></div><button class="custom-remove" aria-label="Remove custom sound"><svg class="icon"><use href="#i-trash" /></svg></button>`;
  row.querySelector("strong").textContent = safe;
  row.querySelector("input[type=checkbox]").addEventListener("change", event => { if(event.target.checked) customNames.add(name); else customNames.delete(name); });
  row.querySelector(".custom-remove").addEventListener("click", async () => {
    try { const response = await fetch(api(`/custom-sound/${encodeURIComponent(name)}`), {method:"DELETE"}); if (!response.ok) throw new Error(); row.remove(); customNames.delete(name); if (!$$(".custom-sound-row", list).length) list.innerHTML = '<p class="empty-inline">No custom sounds saved yet. Teach HeadsUp a sound that matters to you.</p>'; showToast("Custom sound removed."); }
    catch { showToast("Could not remove that sound from the backend."); }
  });
  list.append(row); customNames.add(name);
}
async function loadCustomSounds() {
  try {
    const response = await fetch(api("/sounds")); if (!response.ok) return;
    const data = await response.json();
    const list = $("#customSoundsList"); list.innerHTML = ""; customNames.clear();
    (data.custom || []).forEach(renderCustomSound);
    if (!(data.custom || []).length) list.innerHTML = '<p class="empty-inline">No custom sounds saved yet. Teach HeadsUp a sound that matters to you.</p>';
  } catch {}
}
loadCustomSounds();

function renderSamples() {
  const list = $("#sampleList"); list.innerHTML = "";
  for (let i=0; i<5; i++) {
    const blob = customSamples[i]; const row = document.createElement("div"); row.className = `sample-row ${blob ? "" : "record-sample"}`;
    row.innerHTML = `<span class="sample-number">${i+1}</span>${blob ? `<button class="sample-play" aria-label="Play recording ${i+1}"><svg class="icon"><use href="#i-play" /></svg></button><div class="sample-wave" aria-hidden="true"></div><span class="sample-duration">${Math.max(.1,blob.size/18000).toFixed(1)}s</span><button class="sample-remove" aria-label="Delete recording ${i+1}"><svg class="icon"><use href="#i-trash" /></svg></button>` : `<button class="record-button" data-record-index="${i}"><svg class="icon"><use href="#i-mic" /></svg> Record example</button><span class="sample-duration">${activeRecordIndex === i ? "Recording… click to stop" : ""}</span>`}`;
    if (blob) {
      const wave = row.querySelector(".sample-wave"); for (let j=0;j<42;j++){const bar=document.createElement("i");bar.style.height=`${4+Math.abs(Math.sin(j*2.17+i)*13)}px`;wave.append(bar);}
      row.querySelector(".sample-play").addEventListener("click", () => { const audio = new Audio(URL.createObjectURL(blob)); audio.play(); });
      row.querySelector(".sample-remove").addEventListener("click", () => { customSamples[i]=null; updateSampleProgress(); renderSamples(); });
    } else {
      row.querySelector("[data-record-index]").addEventListener("click", () => activeRecordIndex === i ? stopSampleRecording() : startSampleRecording(i));
    }
    list.append(row);
  }
  const count = customSamples.filter(Boolean).length;
  $("#sampleCount").textContent = `${count} of 5 samples recorded`;
  $("#saveCustomSound").disabled = count < 5 || !$("#soundName").value.trim();
}
function updateSampleProgress(){ $("#sampleCount").textContent = `${customSamples.filter(Boolean).length} of 5 samples recorded`; $("#saveCustomSound").disabled = customSamples.filter(Boolean).length < 5 || !$("#soundName").value.trim(); }
async function startSampleRecording(index) {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { showToast("Audio recording is not supported in this browser."); return; }
  try {
    teachRecordStream = await navigator.mediaDevices.getUserMedia({audio:true});
    teachChunks = []; activeRecordIndex = index;
    teachRecorder = new MediaRecorder(teachRecordStream);
    teachRecorder.ondataavailable = event => { if(event.data.size) teachChunks.push(event.data); };
    teachRecorder.onstop = () => {
      const blob = new Blob(teachChunks, {type:teachRecorder.mimeType || "audio/webm"});
      if(blob.size) customSamples[index] = blob;
      teachRecordStream?.getTracks().forEach(track => track.stop()); teachRecordStream = null; teachRecorder = null; activeRecordIndex = -1; updateSampleProgress(); renderSamples();
    };
    teachRecorder.start(); renderSamples();
    setTimeout(() => { if(teachRecorder?.state === "recording") stopSampleRecording(); }, 3000);
  } catch { activeRecordIndex = -1; showToast("Allow microphone access to record an example."); renderSamples(); }
}
function stopSampleRecording(){ if(teachRecorder?.state === "recording") teachRecorder.stop(); }
$("#soundName").addEventListener("input", updateSampleProgress);
$("#cancelTeach").addEventListener("click", () => { customSamples=[]; $("#soundName").value=""; renderSamples(); goTo("sounds"); });
$("#saveCustomSound").addEventListener("click", async () => {
  const name = $("#soundName").value.trim(); if(!name || customSamples.filter(Boolean).length<5) return;
  const form = new FormData(); form.append("name", name); customSamples.forEach(blob => form.append("clips", blob, "sample.webm"));
  const button=$("#saveCustomSound"); button.disabled=true; button.textContent="Saving…";
  try {
    const response = await fetch(api("/custom-sound"), {method:"POST",body:form});
    if (!response.ok) throw new Error();
    const data=await response.json(); renderCustomSound(data.saved || name.toLowerCase().replace(/\s+/g,"_")); customSamples=[]; $("#soundName").value=""; renderSamples(); goTo("sounds"); showToast("Custom sound saved.");
  } catch { showToast("Could not save sound. Check that POST /custom-sound is running."); }
  finally { button.textContent="Save custom sound"; updateSampleProgress(); }
});
renderSamples();

// If a mic was selected in Settings, pass it to the capture request.
const savedDevice = settings.micDevice;
if(savedDevice) $("#micDevice").value = savedDevice;
