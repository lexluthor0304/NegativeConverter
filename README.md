# 🎞️ Film Negative → Positive Converter

This is a browser-based tool built with HTML and JavaScript that converts scanned film negatives into positive images. It features real-time image adjustments such as rotation, cropping, white balance, temperature, tint, vibrance, and saturation — all styled in a nostalgic 1980s American cyberpunk aesthetic.

## 🌟 Features

- 📷 **Supports PNG/JPG file uploads** (including 16-bit PNGs via UPNG.js)
- 🔄 **Rotation correction** via slider or number input
- ✂️ **Visual cropping** with drag-and-drop overlay
- ⚖️ **One-click white balance** by clicking a gray area in the image
- 🎛️ **Live controls** for temperature, tint, vibrance, and saturation
- 🛡️ **Privacy-friendly**: all image processing happens locally in your browser
- 💾 **One-click download** of the final corrected image

## 📁 Project Structure
NegativeConverter/
├── index.html          # Main application
└── README.md           # You’re reading this file

## 🚀 How to Use

1. Open `index.html` in any modern browser (Chrome/Edge/Firefox recommended)
2. Click **Choose File** to upload your scanned film negative (PNG or JPG)
3. Use the **Rotation** slider or number box to align your image, then click **Apply Rotation**
4. Click **Start Crop**, draw a box with your mouse, and click **Apply** to crop
5. Click on a neutral gray area in the image to perform **White Balance**
6. Use sliders or number inputs to fine-tune **Temperature**, **Tint**, **Vibrance**, and **Saturation**
7. Click **Download Corrected Image** to save your final result

## ⚙️ Technical Highlights

- Uses [`UPNG.js`](https://github.com/photopea/UPNG.js) to decode 16-bit PNGs
- Color adjustment logic is based on RGB ↔ HSL conversion
- Performance optimizations include:
  - Cached DOM access
  - Offscreen canvas reuse
  - Throttled rendering with `requestAnimationFrame`

## 🖼️ Screenshots

> Add screenshots here to demonstrate the UI and the before/after effect.

## 💡 Development & Contributions

Feel free to fork, open issues, or submit pull requests with ideas or improvements.  
This tool is designed to be simple, fast, and modifiable.

## 📄 License

MIT License
