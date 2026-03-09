const video = document.getElementById('video-feed');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

let stream = null;
let isScanning = false;
let isRegistering = false;
let attendanceInterval = null;

// UI Elements
const viewDashboard = document.getElementById('view-dashboard');
const viewRegister = document.getElementById('view-register');
const viewManage = document.getElementById('view-manage');
const navDashboard = document.getElementById('nav-dashboard');
const navRegister = document.getElementById('nav-register');
const navManage = document.getElementById('nav-manage');
const scannerOverlay = document.getElementById('scanner-overlay');
const toastEl = document.getElementById('toast');

// Audio Elements
const scanAudio = new Audio('/static/audio/Loading_1.mp3');
const successAudio = new Audio('/static/audio/success.mp3');
const registerAudio = new Audio('/static/audio/loading.mp3');

// Audio Configuration
let enableAudioFeedback = true; // Toggle this boolean to turn audio on or off
let hasPlayedScanAudio = false; // Tracks if scanning audio fired during this session

// Initialize Camera
async function initCamera() {
    try {
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
        }
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
        video.srcObject = stream;
    } catch (err) {
        showToast('Camera access denied or unavaliable.', 'error');
        console.error(err);
    }
}

// Navigation
navDashboard.addEventListener('click', () => {
    viewDashboard.classList.remove('hidden');
    viewRegister.classList.add('hidden');
    if (viewManage) viewManage.classList.add('hidden');
    navDashboard.classList.add('active');
    navRegister.classList.remove('active');
    if (navManage) navManage.classList.remove('active');
    stopRegistering();
    initCamera();
    fetchLogs();
});

navRegister.addEventListener('click', () => {
    viewRegister.classList.remove('hidden');
    viewDashboard.classList.add('hidden');
    if (viewManage) viewManage.classList.add('hidden');
    navRegister.classList.add('active');
    navDashboard.classList.remove('active');
    if (navManage) navManage.classList.remove('active');
    stopMarkingAttendance();

    // Move video element
    const tipsBox = document.querySelector('.register-tips');
    tipsBox.innerHTML = '';
    tipsBox.appendChild(video.parentElement);
    initCamera();
});

if (navManage) {
    navManage.addEventListener('click', () => {
        viewManage.classList.remove('hidden');
        viewDashboard.classList.add('hidden');
        viewRegister.classList.add('hidden');
        navManage.classList.add('active');
        navDashboard.classList.remove('active');
        navRegister.classList.remove('active');
        stopRegistering();
        stopMarkingAttendance();
        if (stream) { stream.getTracks().forEach(track => track.stop()); stream = null; }
        fetchStudents();
    });
}

function moveVideoToDashboard() {
    const parent = document.querySelector('.live-feed-section');
    let existingCard = parent.querySelector('.camera-card');

    if (!existingCard) {
        existingCard = document.createElement('div');
        existingCard.className = 'camera-card';
        existingCard.innerHTML = `<div class="card-header"><h3><i class='bx bx-video'></i> Live Camera Feed</h3></div>`;
        parent.insertBefore(existingCard, parent.firstChild);
    }

    // Always ensure the video container is inside the dashboard card
    existingCard.appendChild(video.parentElement);
}

// Ensure video defaults to dashboard correctly when nav clicked
navDashboard.addEventListener('click', moveVideoToDashboard);

// Screenshot helper
function captureFrame() {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);
    return canvas.toDataURL('image/jpeg', 0.8);
}

// Toast Notification
function showToast(message, type = 'success') {
    toastEl.textContent = message;

    // Manage class states without overwriting base Tailwind classes
    toastEl.classList.remove('success', 'error', 'hidden');
    toastEl.classList.add(type);

    // trigger reflow
    void toastEl.offsetWidth;
    toastEl.classList.add('show');

    setTimeout(() => {
        toastEl.classList.remove('show');
    }, 3000);
}

// ---- Attendance Logic ----
const btnMarkAttendance = document.getElementById('btn-mark-attendance');

btnMarkAttendance.addEventListener('click', () => {
    if (isScanning) {
        stopMarkingAttendance();
    } else {
        startMarkingAttendance();
    }
});

function startMarkingAttendance() {
    isScanning = true;
    hasPlayedScanAudio = false;
    scannerOverlay.style.display = 'block';
    btnMarkAttendance.innerHTML = "<i class='bx bx-stop'></i> Stop Scanning";
    btnMarkAttendance.classList.add('error');

    attendanceInterval = setInterval(async () => {
        if (!isScanning) return;
        const b64 = captureFrame();

        try {
            const res = await fetch('/attend', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image: b64 })
            });
            const data = await res.json();

            // Logic for playing scan audio ONCE when face is detected
            if (data.face_detected && !hasPlayedScanAudio && enableAudioFeedback && !data.success) {
                scanAudio.currentTime = 0;
                scanAudio.play().catch(e => console.log('Audio play blocked', e));
                hasPlayedScanAudio = true;
            }

            if (data.success) {
                // Play success audio
                if (enableAudioFeedback) {
                    successAudio.currentTime = 0;
                    successAudio.play().catch(e => console.log('Audio play blocked', e));
                }

                showToast(data.message);
                fetchLogs();

                // Stop scanning completely on success so it only triggers once
                stopMarkingAttendance();
            }
        } catch (err) {
            console.error(err);
        }
    }, 1500); // Check every 1.5s
}

function stopMarkingAttendance() {
    isScanning = false;
    scannerOverlay.style.display = 'none';
    btnMarkAttendance.innerHTML = "<i class='bx bx-scan'></i> Scan Face";
    btnMarkAttendance.classList.remove('error');
    clearInterval(attendanceInterval);
    hasPlayedScanAudio = false;

    // Stop scanning audio
    scanAudio.pause();
    scanAudio.currentTime = 0;
}

// ---- Register Logic ----
const btnStartCapture = document.getElementById('btn-start-capture');
const captureProgress = document.getElementById('capture-progress');
const captureCount = document.getElementById('capture-count');

btnStartCapture.addEventListener('click', async () => {
    const empId = document.getElementById('student-id').value;
    const empName = document.getElementById('student-name').value;

    if (!empId || !empName) {
        showToast('Please enter ID and Name', 'error');
        return;
    }

    isRegistering = true;
    btnStartCapture.disabled = true;
    btnStartCapture.innerText = 'Capturing...';

    if (enableAudioFeedback) {
        registerAudio.currentTime = 0;
        registerAudio.play().catch(e => console.log('Audio play blocked', e));
    }

    const frames = [];
    let count = 0;

    const captureLoop = setInterval(async () => {
        frames.push(captureFrame());
        count++;
        captureCount.innerText = count;
        captureProgress.style.width = `${(count / 30) * 100}%`;

        if (count >= 30) {
            clearInterval(captureLoop);
            showToast('Processing face data...');

            try {
                const res = await fetch('/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: empId, name: empName, images: frames })
                });
                const data = await res.json();

                if (data.success) {
                    showToast(data.message);
                    document.getElementById('student-id').value = '';
                    document.getElementById('student-name').value = '';
                } else {
                    showToast(data.message, 'error');
                }
            } catch (err) {
                showToast('Registration failed.', 'error');
            }

            btnStartCapture.disabled = false;
            btnStartCapture.innerText = 'Start Recording';
            captureProgress.style.width = '0%';
            captureCount.innerText = '0';
            isRegistering = false;

            registerAudio.pause();
            registerAudio.currentTime = 0;
        }
    }, 100); // Capture 30 frames over ~3 seconds
});

function stopRegistering() {
    isRegistering = false;
    btnStartCapture.disabled = false;
    btnStartCapture.innerText = 'Start Recording';
    captureProgress.style.width = '0%';
    captureCount.innerText = '0';

    registerAudio.pause();
    registerAudio.currentTime = 0;
}

// ---- Fetch Logs ----
const refreshLogsBtn = document.getElementById('refresh-logs');
const logsBody = document.getElementById('logs-body');
const presentCount = document.getElementById('present-count');

async function fetchLogs() {
    try {
        const res = await fetch('/logs');
        const data = await res.json();

        logsBody.innerHTML = '';

        // Count today's unique presence
        const today = new Date().toISOString().split('T')[0];
        const namesToday = new Set();

        data.forEach(log => {
            if (log.Date === today) namesToday.add(log.Name);

            const div = document.createElement('div');
            div.className = "flex items-center justify-between p-3 rounded-xl hover:bg-slate-800/50 transition-colors border border-transparent hover:border-slate-700 cursor-default";
            div.innerHTML = `
                <div class="flex items-center gap-3">
                    <div class="w-10 h-10 rounded-full bg-brand-900/40 border border-brand-800/50 flex items-center justify-center text-brand-400 font-bold uppercase">
                        ${log.Name.charAt(0)}
                    </div>
                    <div>
                        <p class="text-sm font-bold text-white leading-tight">${log.Name}</p>
                        <p class="text-xs text-slate-400 font-medium mt-0.5">ID: #${log.ID}</p>
                    </div>
                </div>
                <div class="text-right flex flex-col items-end">
                    <span class="inline-flex items-center gap-1 text-xs font-bold text-emerald-400">
                        <i class='bx bxs-check-circle'></i> ${log.Time}
                    </span>
                    <span class="text-[10px] text-slate-500 font-medium uppercase tracking-wider mt-1">${log.Date}</span>
                </div>
            `;
            logsBody.appendChild(div);
        });

        presentCount.innerText = namesToday.size;
    } catch (err) { }
}

refreshLogsBtn.addEventListener('click', fetchLogs);

// ---- Manage Students Logic ----
const refreshStudentsBtn = document.getElementById('refresh-students');
const studentsBody = document.getElementById('students-body');

async function fetchStudents() {
    if (!studentsBody) return;
    try {
        const res = await fetch('/students');
        const data = await res.json();

        studentsBody.innerHTML = '';
        data.forEach(student => {
            const tr = document.createElement('tr');
            tr.className = "hover:bg-slate-800/50 transition-colors";
            tr.innerHTML = `
                <td class="py-4 px-6 text-sm text-slate-400 font-medium">#${student.id}</td>
                <td class="py-4 px-6 text-sm text-white font-bold flex items-center gap-3">
                    <div class="w-10 h-10 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-slate-400 font-bold uppercase overflow-hidden">
                        ${student.name.charAt(0)}
                    </div>
                    ${student.name}
                </td>
                <td class="py-4 px-6">
                    <span class="px-2.5 py-1 text-xs font-bold rounded-full bg-emerald-900/40 text-emerald-400 border border-emerald-800/50">Active</span>
                </td>
                <td class="py-4 px-6 text-right">
                    <div class="flex items-center justify-end gap-2">
                        <button class="action-btn edit-btn w-9 h-9 flex items-center justify-center rounded-lg bg-indigo-900/30 text-indigo-400 transition-all border border-indigo-800/50 hover:bg-indigo-600 hover:text-white" onclick="editStudent('${student.id}', '${student.name}')" title="Edit Student">
                            <i class='bx bx-edit'></i>
                        </button>
                        <button class="action-btn delete-btn w-9 h-9 flex items-center justify-center rounded-lg bg-red-900/30 text-red-400 transition-all border border-red-800/50 hover:bg-red-600 hover:text-white" onclick="deleteStudent('${student.id}')" title="Remove Student">
                            <i class='bx bx-trash'></i>
                        </button>
                    </div>
                </td>
            `;
            studentsBody.appendChild(tr);
        });
    } catch (err) {
        console.error(err);
    }
}

async function deleteStudent(id) {
    if (!confirm('Are you sure you want to delete this student?')) return;
    try {
        const res = await fetch(`/students/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            showToast(data.message);
            fetchStudents();
        } else {
            showToast(data.message, 'error');
        }
    } catch (err) {
        showToast('Error deleting student', 'error');
    }
}

async function editStudent(id, oldName) {
    const newName = prompt('Enter new name for student:', oldName);
    if (!newName || newName === oldName) return;

    try {
        const res = await fetch(`/students/${id}/edit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName })
        });
        const data = await res.json();
        if (data.success) {
            showToast(data.message);
            fetchStudents();
            fetchLogs(); // refresh if logs are showing old names (though not strictly required)
        } else {
            showToast(data.message, 'error');
        }
    } catch (err) {
        showToast('Error updating student', 'error');
    }
}

if (refreshStudentsBtn) refreshStudentsBtn.addEventListener('click', fetchStudents);

// Init
window.addEventListener('DOMContentLoaded', () => {
    initCamera();
    fetchLogs();
    fetchStudents();
});
