import os
import cv2
import base64
import numpy as np
from datetime import datetime
import csv
import shutil
from flask import Flask, render_template, request, jsonify
from utils.face_core import get_face_detector, detect_faces, train_recognizer

app = Flask(__name__)

# Config
DATA_DIR = 'data'
FACES_DIR = os.path.join(DATA_DIR, 'faces')
ATTENDANCE_FILE = os.path.join(DATA_DIR, 'attendance.csv')

os.makedirs(FACES_DIR, exist_ok=True)
if not os.path.exists(ATTENDANCE_FILE):
    with open(ATTENDANCE_FILE, 'w', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(['ID', 'Name', 'Date', 'Time'])

try:
    print("Initializing face detector...")
    face_detector = get_face_detector()
    print("Training LBPH recognizer...")
    recognizer, name_map = train_recognizer(FACES_DIR)
except Exception as e:
    print(f"Error initializing models: {e}")
    face_detector = None
    recognizer = None
    name_map = {}

def decode_base64_image(base64_string):
    if ',' in base64_string:
        base64_string = base64_string.split(',')[1]
    img_data = base64.b64decode(base64_string)
    nparr = np.frombuffer(img_data, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    return img

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/register', methods=['POST'])
def register_face():
    global recognizer, name_map
    data = request.json
    name = data.get('name', '').strip()
    person_id = data.get('id', '').strip()
    images_b64 = data.get('images', [])

    if not name or not person_id or not images_b64:
        return jsonify({'success': False, 'message': 'Missing data.'}), 400

    person_folder = os.path.join(FACES_DIR, f"{name}_{person_id}")
    os.makedirs(person_folder, exist_ok=True)
    
    saved_count = 0
    for idx, b64 in enumerate(images_b64):
        img = decode_base64_image(b64)
        if face_detector:
            faces = detect_faces(img, face_detector)
            found = False
            for (face_x, face_y, face_w, face_h) in faces:
                x1, y1 = face_x, face_y
                x2, y2 = face_x + face_w, face_y + face_h
                # Extract strict face region without arbitrary padding
                face_roi = img[y1:y2, x1:x2]
                if face_roi.shape[0] > 0 and face_roi.shape[1] > 0:
                    gray = cv2.cvtColor(face_roi, cv2.COLOR_BGR2GRAY)
                    # Standardize image prep for LBPH
                    gray = cv2.resize(gray, (200, 200))
                    gray = cv2.equalizeHist(gray)
                    cv2.imwrite(os.path.join(person_folder, f"face_{len(os.listdir(person_folder))}.jpg"), gray)
                    saved_count += 1
                    found = True
                    break # Take first face
            if found:
                pass
        else:
            return jsonify({'success': False, 'message': 'Face detector not loaded.'}), 500

    if saved_count > 0:
        print("Retraining recognizer...")
        recognizer, name_map = train_recognizer(FACES_DIR)
        return jsonify({'success': True, 'message': f'Successfully registered {name} with {saved_count} face captures.'})
    else:
        return jsonify({'success': False, 'message': 'No faces detected in the provided images.'}), 400

@app.route('/attend', methods=['POST'])
def mark_attendance():
    data = request.json
    image_b64 = data.get('image', '')
    if not image_b64:
        return jsonify({'success': False, 'message': 'No image provided.'}), 400
        
    if not recognizer or not name_map:
        return jsonify({'success': False, 'message': 'No faces registered in the system yet.'}), 400

    img = decode_base64_image(image_b64)
    if face_detector:
        faces = detect_faces(img, face_detector)
        face_detected = len(faces) > 0
        
        for (face_x, face_y, face_w, face_h) in faces:
            x1, y1 = face_x, face_y
            x2, y2 = face_x + face_w, face_y + face_h
            
            # Extract strict face region without arbitrary padding
            face_roi = img[y1:y2, x1:x2]
            
            if face_roi.shape[0] > 0 and face_roi.shape[1] > 0:
                gray = cv2.cvtColor(face_roi, cv2.COLOR_BGR2GRAY)
                # Match preprocessing used during training
                gray = cv2.resize(gray, (200, 200))
                gray = cv2.equalizeHist(gray)
                try:
                    id_, confidence = recognizer.predict(gray)
                    print(f"Prediction ID: {id_}, Confidence: {confidence}")
                    # LBPH distance: lower is better.
                    # Slightly relaxed threshold improves real-world matching.
                    if confidence < 65:
                        name = name_map.get(id_, "Unknown")
                        if name != "Unknown":
                            mark_csv_attendance(str(id_), name)
                            return jsonify({'success': True, 'face_detected': True, 'message': f'Attendance marked for {name}.', 'name': name})
                except Exception as e:
                    print(f"Prediction error: {e}")
                        
        if face_detected:
            return jsonify({'success': False, 'face_detected': True, 'message': 'Face detected but not recognized.'}), 404
        else:
            return jsonify({'success': False, 'face_detected': False, 'message': 'No face detected in frame.'}), 404
        
    return jsonify({'success': False, 'face_detected': False, 'message': 'Face detector not loaded.'}), 500

def mark_csv_attendance(person_id, name):
    now = datetime.now()
    date_str = now.strftime('%Y-%m-%d')
    time_str = now.strftime('%H:%M:%S')
    
    # Check if already marked today
    already_marked = False
    with open(ATTENDANCE_FILE, 'r') as f:
        reader = csv.reader(f)
        for row in reader:
            if len(row) >= 3 and row[0] == person_id and row[2] == date_str:
                already_marked = True
                break
                
    if not already_marked:
        with open(ATTENDANCE_FILE, 'a', newline='') as f:
            writer = csv.writer(f)
            writer.writerow([person_id, name, date_str, time_str])

@app.route('/logs', methods=['GET'])
def get_logs():
    logs = []
    if os.path.exists(ATTENDANCE_FILE):
        with open(ATTENDANCE_FILE, 'r') as f:
            reader = csv.DictReader(f)
            for row in reader:
                logs.append(row)
    # Return latest first
    logs.reverse()
    return jsonify(logs)

@app.route('/students', methods=['GET'])
def get_students():
    students = []
    if os.path.exists(FACES_DIR):
        for folder_name in os.listdir(FACES_DIR):
            if '_' in folder_name:
                parts = folder_name.split('_')
                if len(parts) >= 2:
                    name = parts[0]
                    student_id = parts[1]
                    students.append({'id': student_id, 'name': name, 'folder': folder_name})
    return jsonify(students)

@app.route('/students/<student_id>', methods=['DELETE'])
def delete_student(student_id):
    global recognizer, name_map
    found = False
    for folder_name in os.listdir(FACES_DIR):
        if folder_name.endswith(f"_{student_id}"):
            folder_path = os.path.join(FACES_DIR, folder_name)
            try:
                shutil.rmtree(folder_path)
                found = True
                break
            except Exception as e:
                return jsonify({'success': False, 'message': str(e)}), 500
                
    if found:
        print("Retraining recognizer after deletion...")
        recognizer, name_map = train_recognizer(FACES_DIR)
        return jsonify({'success': True, 'message': 'Student deleted successfully.'})
    return jsonify({'success': False, 'message': 'Student not found.'}), 404

@app.route('/students/<student_id>/edit', methods=['POST'])
def edit_student(student_id):
    global recognizer, name_map
    data = request.json
    new_name = data.get('name', '').strip()
    
    if not new_name:
        return jsonify({'success': False, 'message': 'Name cannot be empty.'}), 400
        
    found = False
    for folder_name in os.listdir(FACES_DIR):
        if folder_name.endswith(f"_{student_id}"):
            old_path = os.path.join(FACES_DIR, folder_name)
            new_folder_name = f"{new_name}_{student_id}"
            new_path = os.path.join(FACES_DIR, new_folder_name)
            
            try:
                os.rename(old_path, new_path)
                found = True
                break
            except Exception as e:
                return jsonify({'success': False, 'message': str(e)}), 500
                
    if found:
        print("Retraining recognizer after edit...")
        recognizer, name_map = train_recognizer(FACES_DIR)
        return jsonify({'success': True, 'message': 'Student updated successfully.'})
    return jsonify({'success': False, 'message': 'Student not found.'}), 404

if __name__ == '__main__':
    app.run(debug=True, port=5000)
