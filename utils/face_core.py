import os
import cv2
import numpy as np

from ultralytics import YOLO

# Configuration
MODELS_DIR = os.path.join("data", "models")

def get_face_detector():
    """
    Returns a tuple of (YOLO model, Haar cascade detector).
    """
    cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
    haar_cascade = cv2.CascadeClassifier(cascade_path)
    
    try:
        yolo_model = YOLO("yolov8n-face.pt")
    except Exception as e:
        print(f"Error loading YOLO: {e}")
        yolo_model = None
        
    return (yolo_model, haar_cascade)

def _largest_face_box(boxes):
    if len(boxes) == 0:
        return []
    best_face = None
    max_face_area = 0
    for (fx, fy, fw, fh) in boxes:
        area = fw * fh
        if area > max_face_area:
            max_face_area = area
            best_face = (fx, fy, fw, fh)
    return [best_face] if best_face is not None else []

def _detect_faces_yolo(frame, yolo_model):
    if yolo_model is None:
        return []
    try:
        results = yolo_model(frame, verbose=False)
    except Exception as e:
        print(f"YOLO inference error: {e}")
        return []

    yolo_faces = []
    for result in results:
        names = result.names if hasattr(result, "names") else {}
        # Some face models are single-class detectors and may not expose a "face" label
        # in exactly the expected format. Treat single-class outputs as face detections.
        single_class_model = isinstance(names, dict) and len(names) == 1
        boxes = result.boxes
        if boxes is None:
            continue
        for box in boxes:
            cls_idx = int(box.cls.item()) if box.cls is not None else -1
            label = str(names.get(cls_idx, "")).lower()
            # Trust explicit "face" labels, or any class from a single-class model.
            if not (single_class_model or ("face" in label)):
                continue

            conf = float(box.conf.item()) if box.conf is not None else 0.0
            if conf < 0.20:
                continue

            x1, y1, x2, y2 = box.xyxy[0].tolist()
            x1, y1, x2, y2 = int(x1), int(y1), int(x2), int(y2)
            w, h = x2 - x1, y2 - y1
            if w > 0 and h > 0:
                yolo_faces.append((x1, y1, w, h))

    return _largest_face_box(yolo_faces)

def detect_faces(frame, detectors, use_haar_fallback=True):
    """
    Detects exactly ONE face by finding the largest face.
    Uses YOLO first (when it predicts a 'face' class), then falls back to Haar.
    Returns a list of bounding boxes (x, y, w, h). If zero, returns [].
    """
    yolo_model, haar_cascade = detectors

    # 1) YOLO face detection first.
    yolo_faces = _detect_faces_yolo(frame, yolo_model)
    if yolo_faces:
        return yolo_faces
    
    # 2) Haar fallback.
    if not use_haar_fallback or haar_cascade is None:
        return []
        
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    gray = cv2.equalizeHist(gray)
    
    faces = haar_cascade.detectMultiScale(
        gray,
        scaleFactor=1.1,
        minNeighbors=5,
        minSize=(100, 100),
        flags=cv2.CASCADE_SCALE_IMAGE
    )
    
    if len(faces) == 0:
        return []

    return _largest_face_box(faces)

def train_recognizer(faces_dir):
    """
    Trains an LBPH recognizer on the faces in faces_dir.
    faces_dir should contain folders named 'Name_ID' with images inside.
    Returns trained recognizer and a dictionary mapping IDs to Names.
    """
    recognizer = cv2.face.LBPHFaceRecognizer_create()
    
    faces = []
    ids = []
    name_map = {}
    
    if not os.path.exists(faces_dir):
        os.makedirs(faces_dir, exist_ok=True)
        return None, name_map
        
    for person_folder in os.listdir(faces_dir):
        person_path = os.path.join(faces_dir, person_folder)
        if not os.path.isdir(person_path):
            continue
            
        # Parse Name and ID
        parts = person_folder.split('_')
        if len(parts) < 2:
            continue
            
        name = parts[0]
        try:
            person_id = int(parts[1])
        except ValueError:
            continue
            
        name_map[person_id] = name
        
        for image_name in os.listdir(person_path):
            image_path = os.path.join(person_path, image_name)
            img = cv2.imread(image_path, cv2.IMREAD_GRAYSCALE)
            if img is not None:
                img = cv2.resize(img, (200, 200)) # Enforce standardized size
                img = cv2.equalizeHist(img) # Maintain consistency with detection
                faces.append(img)
                ids.append(person_id)
                
    if len(faces) == 0:
        return None, name_map
        
    recognizer.train(faces, np.array(ids))
    return recognizer, name_map
