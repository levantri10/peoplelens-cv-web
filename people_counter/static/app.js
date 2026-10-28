"use strict";
const $ = id => document.getElementById(id);
const statuses = {uploading:"Đang tải lên",queued:"Đang chuẩn bị",loading:"Đang nạp model",processing:"Đang nhận diện",encoding:"Đang xuất video",live:"Trực tiếp",completed:"Hoàn tất",cancelled:"Đã dừng",failed:"Lỗi xử lý",interrupted:"Bị gián đoạn"};
const activeStatuses = new Set(["uploading","queued","loading","processing","encoding","live"]);
let mode="video", selectedFile=null, selectedURL=null, busy=false, health=null;
let currentJob=null, pollTimer=null, xhr=null, socket=null, cameraStream=null;
let cameraGeneration=0, cameraTimer=null, cameraReadyTimer=null, cameraStarted=0, cameraFrames=0, stoppingCamera=false;
let liveTimeline=[], selectedRun=null;
const captureCanvas=document.createElement("canvas");
const captureContext=captureCanvas.getContext("2d");

function notice(message,kind="") { $("notice").textContent=message; $("notice").className="notice "+kind; $("notice").hidden=!message; }
async function api(url,options) { const response=await fetch(url,options); if(!response.ok){let body;try{body=await response.json();}catch{} const detail=body?.detail;throw new Error(typeof detail==="string"?detail:`Yêu cầu thất bại (${response.status}).`);}return response.json(); }
function showMedia(type) { for(const id of ["emptyState","player","preview","liveCanvas"]) $(id).hidden=id!==type; $("viewer").classList.toggle("has-media",type!=="emptyState"); }
function overlay(message="") { $("viewerOverlay").hidden=!message;$("overlayText").textContent=message; }
function badge(status) { $("runBadge").textContent=statuses[status]||status;$("runBadge").className="run-badge "+(activeStatuses.has(status)?"running":status==="completed"?"success":""); }
function setBusy(value) {
  busy=value;
  for(const id of ["videoTab","webcamTab","confidence","dropzone","chooseInline","demoButton","fileInput","cameraSelect"]) $(id).disabled=value;
  $("startButton").hidden=value;$("stopButton").hidden=!value;
  $("stopButton").disabled=false;
  $("startButton").disabled=!health?.ok||(mode==="video"&&!selectedFile);
  $("demoButton").disabled=value||!health?.ok||!health?.demo_available;
}
function setMode(next) {
  if(busy)return;
  mode=next;
  for(const [id,name] of [["videoTab","video"],["webcamTab","webcam"]]) {$(id).classList.toggle("selected",next===name);$(id).setAttribute("aria-selected",String(next===name));}
  $("videoControls").hidden=next!=="video";$("webcamControls").hidden=next!=="webcam";
  $("startButton").querySelector("span").textContent=next==="webcam"?"Bật webcam & nhận diện":"Bắt đầu nhận diện";
  setBusy(false);
}
function timeLabel(ms,precise=false) { const seconds=Math.max(0,Number(ms)||0)/1000;const base=`${String(Math.floor(seconds/60)).padStart(2,"0")}:${String(Math.floor(seconds%60)).padStart(2,"0")}`;return precise?base+"."+String(Math.floor(ms%1000)).padStart(3,"0"):base; }
function resetMetrics() { for(const id of ["peopleCount","trackedCount","peakCount","fpsCount"])$(id).textContent="—";$("frameLabel").textContent="FRAME —";$("timeLabel").textContent="00:00.000";$("downloads").hidden=true;$("resultsEmpty").hidden=false;$("progressArea").hidden=true;drawChart([]); }
function updateMetrics(record,fps) {
  if(!record)return;
  $("peopleCount").textContent=record.people_count;$("trackedCount").textContent=record.tracked_count;$("peakCount").textContent=record.peak_count;
  $("fpsCount").textContent=Number(fps||0).toFixed(1);$("frameLabel").textContent="FRAME "+String(record.frame_index).padStart(5,"0");$("timeLabel").textContent=timeLabel(record.timestamp_ms,true);
  $("frameDimensions").textContent=`${record.frame_width} × ${record.frame_height} px`;
}
function drawChart(points) {
  const width=760, height=150, left=34, right=6, top=12, bottom=132;
  const max=Math.max(4,...points.map(p=>p.people_count));
  $("chartGrid").replaceChildren();
  for(let i=0;i<3;i++) {const y=top+(bottom-top)*i/2;const line=document.createElementNS("http://www.w3.org/2000/svg","line");for(const [key,value] of Object.entries({x1:left,x2:width-right,y1:y,y2:y,stroke:"#edf0f4","stroke-dasharray":"3 5"}))line.setAttribute(key,value);$("chartGrid").append(line);const label=document.createElementNS("http://www.w3.org/2000/svg","text");label.setAttribute("x","2");label.setAttribute("y",String(y+3));label.setAttribute("fill","#a7afbb");label.setAttribute("font-size","9");label.textContent=String(Math.round(max*(1-i/2)));$("chartGrid").append(label);}
  $("chartEmpty").hidden=points.length>0;
  if(!points.length){$("chartLine").setAttribute("d","");$("chartArea").setAttribute("d","");$("chartStart").textContent="00:00";$("chartEnd").textContent="00:00";return;}
  const start=points[0].timestamp_ms,end=Math.max(start+1,points.at(-1).timestamp_ms);
  const xy=points.map(p=>[left+(p.timestamp_ms-start)/(end-start)*(width-left-right),bottom-p.people_count/max*(bottom-top)]);
  if(xy.length===1)xy.push([left+2,xy[0][1]]);
  const path=xy.map(([x,y],i)=>`${i?"L":"M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  $("chartLine").setAttribute("d",path);$("chartArea").setAttribute("d",`${path} L${xy.at(-1)[0]},${bottom} L${left},${bottom} Z`);
  $("chartStart").textContent=timeLabel(start);$("chartEnd").textContent=timeLabel(end);
}
function downloads(state) {
  const available=state.status==="completed"&&state.processed_frames>0;
  $("downloads").hidden=!available;$("resultsEmpty").hidden=available;
  if(!available)return;
  const base=`/api/jobs/${state.id}/files/`;
  $("downloadVideo").hidden=!state.video_url;$("downloadVideo").href=base+"video";
  $("downloadCsv").href=base+"csv";$("downloadJsonl").href=base+"jsonl";$("downloadSummary").href=base+"summary";
}
function selectFile(file) {
  if(!file||busy)return;
  if(!/\.(mp4|mov|avi|mkv|webm|m4v)$/i.test(file.name)){notice("Hãy chọn video MP4, MOV, AVI, MKV hoặc WEBM.","error");return;}
  if(file.size>(health?.max_upload_mb||500)*1024*1024){notice(`Video vượt giới hạn ${health?.max_upload_mb||500} MB.` ,"error");return;}
  selectedFile=file;selectedRun=null;
  if(selectedURL)URL.revokeObjectURL(selectedURL);
  selectedURL=URL.createObjectURL(file);$("player").src=selectedURL;showMedia("player");
  $("fileName").textContent=file.name;$("fileDetail").textContent=(file.size/1024/1024).toFixed(1)+" MB · Bấm để đổi video";
  $("sourceLabel").textContent="VIDEO · "+file.name.slice(0,48);badge("Sẵn sàng");notice("");resetMetrics();setMode("video");
}
function upload(file) {
  return new Promise((resolve,reject)=>{
    xhr=new XMLHttpRequest();xhr.open("POST","/api/jobs");
    xhr.upload.onprogress=event=>{if(event.lengthComputable){const percent=Math.round(event.loaded/event.total*100);$("progressBar").value=percent;$("progressValue").textContent=percent+"%";$("progressLabel").textContent="Đang tải video lên máy chủ";}};
    xhr.onload=()=>{let body;try{body=JSON.parse(xhr.responseText);}catch{reject(new Error("Máy chủ trả về dữ liệu không hợp lệ."));return;}xhr=null;if(body.id)resolve(body);else reject(new Error(typeof body.detail==="string"?body.detail:"Không thể tải video."));};
    xhr.onerror=()=>{xhr=null;reject(new Error("Mất kết nối tới ứng dụng Python."));};xhr.onabort=()=>{xhr=null;reject(new Error("Đã hủy tải video."));};
    const form=new FormData();form.append("file",file);form.append("confidence",$("confidence").value);xhr.send(form);
  });
}
async function startVideo(demo=false) {
  if(busy||(!demo&&!selectedFile))return;
  notice("");resetMetrics();setBusy(true);$("player").pause();overlay(demo?"Đang chuẩn bị video mẫu…":"Đang tải video…");badge("uploading");$("progressArea").hidden=false;
  try { const state=demo?await api(`/api/demo?confidence=${$("confidence").value}`,{method:"POST"}):await upload(selectedFile);currentJob=state.id;localStorage.setItem("peoplelens.active",state.id);$("sourceLabel").textContent="VIDEO · "+state.name.slice(0,45);pollJob(state.id); }
  catch(error){overlay();setBusy(false);badge("Sẵn sàng");$("progressArea").hidden=true;notice(error.message,"error");}
}
async function pollJob(id) {
  clearTimeout(pollTimer);
  try {
    const state=await api(`/api/jobs/${id}`);if(currentJob!==id)return;
    selectedRun=state;badge(state.status);updateMetrics(state.latest,state.processing_fps);drawChart(state.timeline||[]);
    $("sourceLabel").textContent=(state.source_type==="webcam"?"WEBCAM · ":"VIDEO · ")+state.name.slice(0,45);
    if(activeStatuses.has(state.status)) {
      setBusy(true);$("progressArea").hidden=state.source_type==="webcam";$("progressBar").value=state.progress;$("progressValue").textContent=Math.round(state.progress)+"%";$("progressLabel").textContent=`${statuses[state.status]} · ${state.processed_frames}${state.total_frames?" / "+state.total_frames:""} frame`;
      overlay(["queued","loading","uploading"].includes(state.status)?"Đang nạp model & chuẩn bị khung hình…":state.status==="encoding"?"Đang mã hóa video kết quả…":"");
      if(state.latest&&state.source_type==="video") {$("preview").src=`/api/jobs/${id}/preview?t=${Date.now()}`;showMedia("preview");}
      pollTimer=setTimeout(()=>pollJob(id),700);
    } else {
      currentJob=null;localStorage.removeItem("peoplelens.active");setBusy(false);overlay();$("progressArea").hidden=true;downloads(state);
      if(state.video_url){$("player").src=state.video_url;showMedia("player");}
      if(state.status==="completed")notice(`Đã hoàn tất ${state.processed_frames.toLocaleString("vi-VN")} khung hình. Bạn có thể xem lại và tải kết quả.`,"success");
      else notice(state.error||"Phiên đã dừng. Bạn có thể bắt đầu nguồn mới.",state.status==="failed"?"error":"");
      loadHistory();
    }
  } catch(error) {
    if(currentJob===id){notice(error.message+" Đang thử kết nối lại…","error");pollTimer=setTimeout(()=>pollJob(id),2500);}
  }
}
async function stopRun() {
  $("stopButton").disabled=true;
  if(xhr){xhr.abort();return;}
  if(socket||cameraStream){await stopCamera();return;}
  if(currentJob){try{await api(`/api/jobs/${currentJob}/cancel`,{method:"POST"});notice("Đang dừng sau khung hình hiện tại…");}catch(error){notice(error.message,"error");$("stopButton").disabled=false;}}
}
async function listCameras() {
  if(!navigator.mediaDevices?.enumerateDevices)return;
  try {const devices=await navigator.mediaDevices.enumerateDevices();const selected=$("cameraSelect").value;$("cameraSelect").replaceChildren(new Option("Camera mặc định",""));let i=0;for(const device of devices.filter(d=>d.kind==="videoinput")){i++;$("cameraSelect").add(new Option(device.label||`Camera ${i}`,device.deviceId));}$("cameraSelect").value=selected;}catch{}
}
function closeMedia() { clearTimeout(cameraTimer);clearTimeout(cameraReadyTimer);cameraStream?.getTracks().forEach(track=>track.stop());cameraStream=null;$("cameraVideo").srcObject=null; }
async function startCamera() {
  if(busy)return;
  $("player").pause();
  if(!navigator.mediaDevices?.getUserMedia){notice("Webcam cần trình duyệt hỗ trợ camera và địa chỉ localhost hoặc HTTPS.","error");return;}
  notice("");resetMetrics();setBusy(true);badge("loading");overlay("Đang xin quyền truy cập camera…");
  const generation=++cameraGeneration;stoppingCamera=false;liveTimeline=[];cameraFrames=0;
  try {
    const device=$("cameraSelect").value;
    const stream=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:960},height:{ideal:540},...(device?{deviceId:{exact:device}}:{facingMode:"user"})},audio:false});
    if(generation!==cameraGeneration){stream.getTracks().forEach(track=>track.stop());return;}
    cameraStream=stream;$("cameraVideo").srcObject=stream;await $("cameraVideo").play();await listCameras();
    if(generation!==cameraGeneration)return;
    for(const track of stream.getVideoTracks())track.addEventListener("ended",()=>{if(!stoppingCamera){notice("Camera đã ngắt kết nối.","error");stopCamera();}});
    overlay("Đang nạp model cho webcam…");
    const protocol=location.protocol==="https:"?"wss":"ws";
    const ws=new WebSocket(`${protocol}://${location.host}/ws/webcam?confidence=${$("confidence").value}`);socket=ws;
    cameraReadyTimer=setTimeout(()=>{if(ws.readyState!==WebSocket.CLOSED){notice("Kết nối webcam quá thời gian chờ. Hãy thử lại.","error");stopCamera();}},60000);
    ws.onmessage=event=>{
      if(generation!==cameraGeneration)return;
      const data=JSON.parse(event.data);
      if(data.type==="ready") {clearTimeout(cameraReadyTimer);currentJob=data.session_id;localStorage.setItem("peoplelens.active",currentJob);cameraStarted=performance.now();badge("live");$("sourceLabel").textContent="WEBCAM · TRỰC TIẾP";overlay();showMedia("liveCanvas");sendFrame(ws,generation);}
      if(data.type==="result") {cameraFrames++;drawDetections(data);updateMetrics(data,cameraFrames/Math.max(.001,(performance.now()-cameraStarted)/1000));if(!liveTimeline.length||data.timestamp_ms-liveTimeline.at(-1).timestamp_ms>=500){liveTimeline.push({timestamp_ms:data.timestamp_ms,people_count:data.people_count});if(liveTimeline.length>300)liveTimeline=liveTimeline.filter((_,i)=>i%2===0);drawChart(liveTimeline);}cameraTimer=setTimeout(()=>sendFrame(ws,generation),70);}
      if(data.type==="error"){notice(data.message,"error");stoppingCamera=true;closeMedia();overlay();ws.close();}
      if(data.type==="stopped"){stoppingCamera=true;ws.close();}
    };
    ws.onerror=()=>notice("Không kết nối được kênh nhận diện webcam. Kiểm tra ứng dụng Python.","error");
    ws.onclose=()=>{if(socket!==ws)return;socket=null;closeMedia();overlay();setBusy(false);const id=currentJob;currentJob=null;localStorage.removeItem("peoplelens.active");if(id){currentJob=id;pollJob(id);}else badge("Sẵn sàng");};
  } catch(error) {
    closeMedia();overlay();setBusy(false);badge("Sẵn sàng");
    const messages={NotAllowedError:"Bạn chưa cho phép truy cập camera. Mở quyền camera trong trình duyệt rồi thử lại.",NotFoundError:"Không tìm thấy webcam trên thiết bị.",NotReadableError:"Không mở được camera. Có thể camera đang được ứng dụng khác sử dụng.",OverconstrainedError:"Camera đã chọn không còn khả dụng. Hãy chọn camera mặc định."};notice(messages[error.name]||error.message,"error");
  }
}
function sendFrame(ws,generation) {
  if(generation!==cameraGeneration||stoppingCamera||ws.readyState!==WebSocket.OPEN||!cameraStream)return;
  const video=$("cameraVideo");if(!video.videoWidth){cameraTimer=setTimeout(()=>sendFrame(ws,generation),100);return;}
  const scale=Math.min(1,960/video.videoWidth);captureCanvas.width=Math.round(video.videoWidth*scale);captureCanvas.height=Math.round(video.videoHeight*scale);captureContext.drawImage(video,0,0,captureCanvas.width,captureCanvas.height);
  captureCanvas.toBlob(blob=>{if(blob&&ws.readyState===WebSocket.OPEN&&!stoppingCamera&&generation===cameraGeneration)ws.send(blob);},"image/jpeg",.82);
}
function drawDetections(record) {
  const canvas=$("liveCanvas");canvas.width=record.frame_width;canvas.height=record.frame_height;const context=canvas.getContext("2d");context.drawImage(captureCanvas,0,0,canvas.width,canvas.height);context.font="13px Segoe UI, sans-serif";context.lineWidth=2;
  for(const detection of record.detections){const [x1,y1,x2,y2]=detection.bbox_xyxy;const tracked=detection.track_id!==null;const color=tracked?"#67d392":"#efbb59";context.strokeStyle=color;context.strokeRect(x1,y1,x2-x1,y2-y1);const text=`person ${tracked?"#"+detection.track_id:"new"} ${Math.round(detection.confidence*100)}%`;const y=Math.max(22,y1);context.fillStyle=color;context.fillRect(x1,y-22,context.measureText(text).width+12,22);context.fillStyle="#14251c";context.fillText(text,x1+6,y-7);}
}
async function stopCamera() {
  stoppingCamera=true;++cameraGeneration;closeMedia();overlay();
  if(socket){const ws=socket;if(ws.readyState===WebSocket.OPEN){ws.send(JSON.stringify({type:"stop"}));setTimeout(()=>{if(ws.readyState!==WebSocket.CLOSED)ws.close();},2500);}else ws.close();}
  else {setBusy(false);badge("Sẵn sàng");}
}
function escapeHtml(value) {return String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));}
async function loadHistory() {
  try {const rows=await api("/api/jobs");if(!rows.length){$("historyBody").innerHTML='<tr><td colspan="6" class="table-empty">Chưa có phiên xử lý. Bắt đầu với video mẫu ở trên.</td></tr>';return;}
    $("historyBody").innerHTML=rows.map(row=>`<tr><td><div class="source-name"><svg><use href="#i-${row.source_type==="webcam"?"camera":"video"}"/></svg><span title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</span></div></td><td>${escapeHtml(new Date(row.created_at).toLocaleString("vi-VN",{hour:"2-digit",minute:"2-digit",day:"2-digit",month:"2-digit"}))}</td><td>${Number(row.processed_frames||0).toLocaleString("vi-VN")}</td><td>${Number(row.peak_count||0)} người</td><td><span class="history-status ${escapeHtml(row.status)}">${escapeHtml(statuses[row.status]||row.status)}</span></td><td><button class="history-open" data-run="${escapeHtml(row.id)}" aria-label="Xem phiên ${escapeHtml(row.name)}">↗</button></td></tr>`).join("");
  }catch(error){notice("Không tải được lịch sử: "+error.message,"error");}
}
async function openRun(id) {
  if(busy){notice("Hãy dừng hoặc chờ phiên hiện tại trước khi xem phiên khác.");return;}
  currentJob=id;notice("");await pollJob(id);$("workspace").scrollIntoView({behavior:"smooth"});
}
async function init() {
  drawChart([]);
  try {health=await api("/api/health");$("modelStatus").replaceChildren();const dot=document.createElement("span");dot.className="status-dot"+(health.ok?"":" loading");$("modelStatus").append(dot,document.createTextNode(health.ok?"Model sẵn sàng · YOLOv8n":"Chưa tìm thấy model"));$("deviceCaption").textContent=health.device_name;$("uploadLimit").textContent=`Tối đa ${health.max_upload_mb} MB`;if(!health.ok)notice("Chưa có model. Giải nén artifact hoặc đặt CV_MODEL_PATH theo README.","error");setBusy(false);const saved=localStorage.getItem("peoplelens.active");if(saved){try{const state=await api(`/api/jobs/${saved}`);if(activeStatuses.has(state.status)&&state.source_type!=="webcam"){currentJob=saved;pollJob(saved);}else localStorage.removeItem("peoplelens.active");}catch{localStorage.removeItem("peoplelens.active");}}}
  catch(error){notice("Ứng dụng Python chưa sẵn sàng: "+error.message,"error");$("modelStatus").textContent="Mất kết nối máy chủ";}
  loadHistory();listCameras();
}
$("videoTab").addEventListener("click",()=>setMode("video"));$("webcamTab").addEventListener("click",()=>setMode("webcam"));
$("confidence").addEventListener("input",()=>$("confidenceValue").textContent=Number($("confidence").value).toFixed(2));
for(const id of ["chooseInline","dropzone"])$(id).addEventListener("click",()=>$("fileInput").click());
$("fileInput").addEventListener("change",event=>selectFile(event.target.files[0]));
for(const event of ["dragenter","dragover"])$("dropzone").addEventListener(event,e=>{e.preventDefault();if(!busy)$("dropzone").classList.add("dragover");});
for(const event of ["dragleave","drop"])$("dropzone").addEventListener(event,e=>{e.preventDefault();$("dropzone").classList.remove("dragover");});
$("dropzone").addEventListener("drop",event=>selectFile(event.dataTransfer.files[0]));
$("demoButton").addEventListener("click",()=>startVideo(true));$("startButton").addEventListener("click",()=>mode==="video"?startVideo():startCamera());$("stopButton").addEventListener("click",stopRun);
$("refreshHistory").addEventListener("click",loadHistory);$("historyBody").addEventListener("click",event=>{const button=event.target.closest("[data-run]");if(button)openRun(button.dataset.run);});
window.addEventListener("beforeunload",()=>{closeMedia();socket?.close();});
init();
