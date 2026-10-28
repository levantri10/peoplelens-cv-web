# Third-party notices

- **Ultralytics / exported YOLOv8n model**: the person model was trained with Ultralytics and exported from the supplied `best.pt`. Ultralytics license text is retained in `web/public/licenses/ultralytics-LICENSE.txt`. See https://github.com/ultralytics/ultralytics and https://www.ultralytics.com/license.
- **ONNX Runtime Web 1.31.1**: Microsoft, MIT license. Its license and ThirdPartyNotices are retained under `web/public/licenses/onnxruntime-*`. The deployed module/WASM files are copied without modification from the locked npm dependency. See https://github.com/microsoft/onnxruntime.
- **ByteTrack algorithm**: Yifu Zhang et al., ECCV 2022. The browser implementation expresses Kalman XYAH, two-stage association and track lifecycle in JavaScript; retain the upstream MIT notice at `web/public/licenses/bytetrack-LICENSE.txt`. See https://github.com/ifzhang/ByteTrack.
- **Sample video**: the first five seconds of OpenCV `samples/data/vtest.avi`, converted to H.264 without annotations. Source: https://github.com/opencv/opencv/blob/4.x/samples/data/vtest.avi. It is provided as a pipeline fixture, without frame-by-frame ground truth.
- **Vite** and npm transitive dependencies retain their respective licenses in the installed packages. Runtime dependency versions are locked in `package-lock.json`.

Public deployment contains the model and static application assets. It does not contain uploaded videos, frames or user session exports.
