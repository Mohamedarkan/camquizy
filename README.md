ArkanCam is a photo booth app that works entirely in your browser using hand gestures. You don't need to install anything or set up a backend server, just run a local server.

It was made by Mohamed Arkan.

What it does:
ArkanCam takes a picture using your hands as a frame. Then, it turns the photo into a 3x3 puzzle with a black-and-white filter, like an old photo booth. You can solve the puzzle using pinch gestures. When you finish, the solved photo is added to a downloadable photo strip.

What you need:
- Browser: Chrome or Edge (best), Firefox also works.
- Hardware: A webcam.
- Internet: You need it to download the MediaPipe model, which is about 10MB and only happens the first time you use it.
- Local server: The app must be run through a local server; you can't just open the HTML file directly.

How to set it up:
1. Copy the code:
   git clone https://github.com/YOUR-USERNAME/ArkanCam.git
   cd ArkanCam

2. Start a local server:
   The app needs to run over HTTP because it uses ES modules and camera access.
   The easiest way is to install the Live Server extension in VS Code and click "Go Live." Any other static server will also work, like python3 -m http.server or npx serve.

3. Open it in your browser:
   http://localhost:5500
   You'll need to allow the browser to access your camera when it asks.

Project files:
ArkanCam/
├── index.html (the main page)
├── app.js (handles hand tracking, puzzles, and the gallery)
├── css/
│   └── styles.css (styling and layout)
└── .gitignore

Gestures you can use:
- Pinch with both hands: This freezes the screen and starts a countdown to take the photo.
- Pinch with one hand over a puzzle piece: This lets you drag that piece around.
- Make a fist and hold it: This saves a finished puzzle or resets the puzzle board.

How it works step-by-step:
1. Show both hands to the camera and pinch to define the area for the photo.
2. Keep pinching through the countdown; the photo will be taken automatically.
3. The photo will then be turned into a 3x3 puzzle with a black-and-white filter.
4. Move the puzzle pieces around using the pinch-and-drag gesture.
5. Once you solve the puzzle, make a fist to save it to your photo strip, complete with a small shattering effect.
6. After you save 3 puzzles, you can download the entire photo strip.

What it's built with:
- MediaPipe Tasks Vision for detecting hand landmarks.
- Canvas 2D API for drawing, creating puzzle pieces, and applying the photo booth effect.
- Vanilla JavaScript (ES Modules), meaning no big frameworks were used.
- CSS custom properties for easy theming and layout.
Everything is loaded from a CDN, so you don't need to install anything extra.

If you run into problems:
Camera won't turn on:
Make sure no other application like Teams, Zoom, or Discord is currently using your camera.

Model won't load:
Check your internet connection. The MediaPipe model (around 10MB) is downloaded from storage.googleapis.com, and the runtime is from cdn.jsdelivr.net. If your network blocks these addresses, the app won't start.

Screen is black:
Ensure you're running the app using a local server (HTTP). Opening index.html directly from your file system won't work.

Pinch gesture isn't detected:
Make sure you have good lighting and both your hands are clearly visible to the camera. Bring your thumb and index finger close together until the marker on the screen lights up.

Browser compatibility:
- Chrome / Edge: Recommended
- Firefox: Works fine
- Safari: Limited support (might need extra permissions)
- Mobile: Limited support (using a desktop is recommended)

License:
MIT license. You are free to use, change, and share it.