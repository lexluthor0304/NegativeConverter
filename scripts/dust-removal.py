import sys
import os
import cv2
import numpy as np
from PIL import Image, ImageCms
from PyQt6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QLabel,
    QPushButton, QHBoxLayout, QFileDialog, QListWidget, QListWidgetItem,
    QSpinBox, QGraphicsView, QGraphicsScene, QGraphicsPixmapItem,
    QSizePolicy, QProgressDialog, QSlider, QDialog, QCheckBox,
    QGridLayout, QAbstractItemView, QScrollArea, QTextEdit, QLineEdit,
    QMessageBox
)
from PyQt6.QtGui import (
    QPixmap, QImage, QPainter, QColor, QPen, QCursor, QFont,
    QIcon, QAction, QRegularExpressionValidator
)
from PyQt6.QtCore import (
    Qt, QRectF, QPoint, pyqtSignal, pyqtSlot, QObject, QThread,
    QRunnable, QThreadPool, QPointF, QSize, QRegularExpression
)
from appdirs import *
from functools import partial
import json

current_version = "1.02"


class ImageTaskSignals(QObject):
    finished = pyqtSignal(object)


class ImageTask(QRunnable):
    def __init__(self, path):
        super().__init__()
        self.path = path
        self.signals = ImageTaskSignals()

    def run(self):
        image_data = ImageData(self.path)
        image_data.run()
        self.signals.finished.emit(image_data)


class ImageData(QObject):
    finished = pyqtSignal()

    def __init__(self, path):
        super().__init__()
        self.path = path
        self.image = None
        self.mask = None
        self.inpainted = None
        self.icc_profile = None
        self.scharr_level = (0, 0, 0, 0)
        self.scharr_all = None
        self.linien = None
        self.gauss = None
        self.allowed_area_mask = None
        self.highlight_mask = None
        self.grayscale = False

    def run(self):
        # Open with PIL first to get ICC profile
        img_pil = Image.open(self.path)
        self.icc_profile = img_pil.info.get('icc_profile')

        # Read with OpenCV
        self.image = cv2.imread(self.path, cv2.IMREAD_ANYCOLOR | cv2.IMREAD_ANYDEPTH)

        # Check if grayscale (2 dimensions) and convert
        if len(self.image.shape) == 2:
            self.image = cv2.cvtColor(self.image, cv2.COLOR_GRAY2BGR)
            self.grayscale = True

        # Process with default strength
        self.strength = 3
        self.process_image(1)
        self.mask = self.mask
        self.inpaint_image()
        self.inpainted = self.inpainted
        self.finished.emit()

    def correct_tile(self, image, strength):
        # Convert to grayscale
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        h, w = gray.shape

        # Calculate parameters based on image size
        factor = h // 2
        minimum_line = factor // 10
        TH_gauss = 20
        TH_scharr = 0.7 * strength
        scharr_gauss = 12
        highpass_gauss = 3

        # Scharr edge detection in X and Y
        diff_x = cv2.Scharr(gray, cv2.CV_64F, 1, 0)
        diff_y = cv2.Scharr(gray, cv2.CV_64F, 0, 1)

        # Compute magnitude
        scharr_raw = np.sqrt(diff_x * diff_x + diff_y * diff_y)

        # Normalize to 0-255
        level = cv2.normalize(scharr_raw, None, 0, 255, cv2.NORM_MINMAX, cv2.CV_8U)
        scharr_all = level

        # Threshold the scharr result
        value = int(TH_scharr * 5)
        scharr = cv2.inRange(level, value, 255)

        # Apply Gaussian blur to smooth
        scharr = cv2.GaussianBlur(scharr, (scharr_gauss + 1, scharr_gauss + 1), 0)

        # Create line mask
        line_mask = np.zeros_like(gray, dtype=np.uint8)

        # Detect lines using HoughLinesP if scharr has content
        if np.sum(scharr) > 0:
            lines = cv2.HoughLinesP(
                scharr,
                rho=1,
                theta=np.pi / 180,
                threshold=200,
                minLineLength=minimum_line,
                maxLineGap=100
            )

            if lines is not None:
                for line in lines:
                    x1, y1, x2, y2 = line[0]
                    cv2.line(line_mask, (x1, y1), (x2, y2), 255, 10)

        # Highpass filter
        blur = cv2.GaussianBlur(gray, (highpass_gauss * 2 + 1, highpass_gauss * 2 + 1), 0)
        highpass = cv2.subtract(gray, blur)
        blur_inv = cv2.GaussianBlur(gray, (TH_gauss * 2 + 1, TH_gauss * 2 + 1), 0)
        highpass_inv = cv2.subtract(blur_inv, gray)

        # Combine masks
        mask = cv2.inRange(highpass, 0, 254)
        mask = cv2.bitwise_not(mask)
        mask = cv2.bitwise_or(mask, highpass_inv)
        mask = cv2.bitwise_or(mask, line_mask)

        for i in range(3):
            mask = cv2.GaussianBlur(mask, (scharr_gauss + 1, scharr_gauss + 1), 0)

        return scharr, scharr_all, line_mask, mask

    def analyze_contours(self, img, scharr_all):
        # Find contours
        contours, _ = cv2.findContours(img, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        marked = img.copy()
        areas = [cv2.contourArea(cnt) for cnt in contours]
        height, width = img.shape[:2]

        gray = cv2.cvtColor(self.image, cv2.COLOR_BGR2GRAY)

        # Create output masks
        allowed_conturs = []
        highlights = []
        highlight_mask = np.zeros((height, width), dtype=np.uint8)
        allowed_area_mask = np.zeros((height, width), dtype=np.uint8)

        # Area thresholds based on image size
        Area_TH = int(height * width * 2.5e-05)
        maximum = int(height * width * 0.00015)
        minimum = int(height * width * 1e-07)

        for cnt in contours:
            area = cv2.contourArea(cnt)
            if area < minimum or area > maximum:
                continue

            x, y, w, h = cv2.boundingRect(cnt)
            roi = scharr_all[y:y+h, x:x+w]
            cx = x + w // 2
            cy = y + h // 2

            # Check center value from scharr
            center_value = scharr_all[cy, cx] if 0 <= cy < height and 0 <= cx < width else 0

            # Check edge proximity
            top = y
            bottom = height - (y + h)
            left = x
            right = width - (x + w)
            edge_mean = cv2.mean(roi)[0]

            if center_value < 50:
                allowed_conturs.append(cnt)
                cv2.drawContours(allowed_area_mask, [cnt], -1, 255, thickness=cv2.FILLED)
            else:
                highlights.append(cnt)
                cv2.drawContours(highlight_mask, [cnt], -1, 255, thickness=cv2.FILLED)

        return allowed_area_mask, highlight_mask

    def process_image(self, strength):
        img = self.image
        h, w = img.shape[:2]
        h_step = h // 2
        w_step = w // 2

        mask = np.zeros((h, w), dtype=np.uint8)
        scharr = np.zeros((h, w), dtype=np.uint8)

        self.scharr_all = np.zeros((h, w), dtype=np.uint8)
        self.linien = np.zeros((h, w), dtype=np.uint8)
        self.gauss = np.zeros((h, w), dtype=np.uint8)

        # Process in 2x2 tiles
        i = 0
        for row in range(2):
            for col in range(2):
                y1 = row * h_step
                y2 = (row + 1) * h_step if row < 1 else h
                x1 = col * w_step
                x2 = (col + 1) * w_step if col < 1 else w

                tile = img[y1:y2, x1:x2]
                scharr_corrected, scharr_all_tile, linien_tile, gauss_tile = self.correct_tile(tile, strength)

                scharr[y1:y2, x1:x2] = scharr_corrected
                self.scharr_all[y1:y2, x1:x2] = scharr_all_tile
                self.scharr_level = (
                    int(self.scharr_level[0]),
                    int(self.scharr_level[1]),
                    int(self.scharr_level[2]),
                    int(self.scharr_level[3])
                )
                self.linien[y1:y2, x1:x2] = linien_tile
                self.gauss[y1:y2, x1:x2] = gauss_tile
                i += 1

        # Combine scharr with line/gauss masks
        increase = cv2.bitwise_and(scharr, cv2.bitwise_not(self.linien))
        increase = cv2.multiply(increase, self.gauss)

        # Analyze contours
        self.allowed_area_mask, self.highlight_mask = self.analyze_contours(increase, self.scharr_all)

        # Create final mask with dilation
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (int(h * 0.0015), int(h * 0.0015)))
        maske = cv2.dilate(self.allowed_area_mask, kernel, iterations=1)
        self.mask = maske

    def inpaint_image(self):
        # Handle 8-bit and 16-bit images
        if self.image.dtype == np.uint8:
            result = cv2.inpaint(self.image, self.mask, 3, cv2.INPAINT_TELEA)
        else:
            # For 16-bit: downscale to 8-bit, inpaint, upscale back
            image_8bit = (self.image / 256).astype(np.uint8)
            inpainted_8bit = cv2.inpaint(image_8bit, self.mask, 3, cv2.INPAINT_TELEA)
            inpainted_16bit = inpainted_8bit.astype(np.uint16) * 256
            mask3 = cv2.merge([self.mask, self.mask, self.mask])
            result = np.where(mask3 > 0, inpainted_16bit, self.image)

        self.inpainted = result

    def update_image(self, strength):
        img = self.image
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        h, w = gray.shape
        h_step = h // 2
        w_step = w // 2

        scharr = np.zeros((h, w), dtype=np.uint8)
        factor = 10

        # Process in 2x2 tiles
        i = 0
        for row in range(2):
            for col in range(2):
                y1 = row * h_step
                y2 = (row + 1) * h_step if row < 1 else h
                x1 = col * w_step
                x2 = (col + 1) * w_step if col < 1 else w

                tile = gray[y1:y2, x1:x2]

                # Scharr edge detection
                diff_x = cv2.Scharr(tile, cv2.CV_64F, 1, 0)
                diff_y = cv2.Scharr(tile, cv2.CV_64F, 0, 1)
                scharr_raw = np.sqrt(diff_x * diff_x + diff_y * diff_y)
                value = cv2.normalize(scharr_raw, None, 0, 255, cv2.NORM_MINMAX, cv2.CV_8U)

                scharr_corrected = cv2.inRange(value, int(strength * factor), 255)
                scharr[y1:y2, x1:x2] = scharr_corrected
                i += 1

        self.scharr_level = (int(self.scharr_level[0]), int(self.scharr_level[1]),
                             int(self.scharr_level[2]), int(self.scharr_level[3]))

        # Combine with line/gauss masks
        increase = cv2.bitwise_and(scharr, cv2.bitwise_not(self.linien))
        increase = cv2.multiply(increase, self.gauss)

        # Use existing allowed_area_mask and highlight_mask
        mask = self.allowed_area_mask
        self.highlight_mask = self.highlight_mask

        # Create final mask with dilation
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (int(h * 0.0015), int(h * 0.0015)))
        maske = cv2.dilate(mask, kernel, iterations=1)
        self.mask = maske

    def update_strength(self, strength):
        self.strength = strength
        self.update_image(strength)
        self.mask = self.mask
        self.inpaint_image()
        self.inpainted = self.inpainted


class ImageCanvas(QLabel):
    def __init__(self):
        super().__init__()
        self.setMouseTracking(True)
        self.setSizePolicy(QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Ignored)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)

        self.drawing = False
        self.mode = 'view'
        self.current_image = None
        self.last_pos = None
        self.overlay = None
        self.view_mode = 1
        self.display_img = None
        self.cursor_pos = QPoint(0, 0)
        self.brush_radius = 2

        self.overlay = QImage(700, 700, QImage.Format.Format_ARGB32)
        self.overlay.fill(Qt.GlobalColor.transparent)

        self.pixmap = None
        self.scaled_pixmap = None
        self.zoom_factor = 0.15
        self.min_zoom = 1.0
        self.max_zoom = 10.0
        self.zoom_center = QPointF(0, 0)
        self.wheel_counter = 0

        self.resize(700, 700)

    def clear(self):
        self.current_image = None
        self.display_img = None
        self.pixmap = None
        self.scaled_pixmap = None

        self.overlay = QImage(self.size(), QImage.Format.Format_ARGB32)
        self.overlay.fill(Qt.GlobalColor.transparent)

        blank = QPixmap(700, 700)
        blank.fill(Qt.GlobalColor.white)

        painter = QPainter(blank)
        painter.setPen(QColor('gray'))
        painter.setFont(QFont('Arial', 18))
        text = 'Drop dusty images here :)'
        rect = blank.rect()
        painter.drawText(rect, Qt.AlignmentFlag.AlignCenter, text)
        painter.end()

        self.setPixmap(blank)
        self.resize(700, 700)
        self.updateGeometry()

    def resizeEvent(self, event):
        if self.current_image is not None:
            self.set_image(self.current_image, self.view_mode)

    def create_circle_cursor(self, color):
        radius = self.brush_radius
        size = radius * 2 + 1
        pixmap = QPixmap(size, size)
        pixmap.fill(Qt.GlobalColor.transparent)

        painter = QPainter(pixmap)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setPen(QColor(color))
        painter.setBrush(Qt.BrushStyle.NoBrush)
        painter.drawEllipse(1, 1, size - 2, size - 2)
        painter.end()

        hotspot = QPoint(radius, radius)
        return QCursor(pixmap, hotspot.x(), hotspot.y())

    def enterEvent(self, event):
        self.setCursor(self.create_circle_cursor(QColor(255, 0, 255)))
        super().enterEvent(event)

    def leaveEvent(self, event):
        self.unsetCursor()
        super().leaveEvent(event)

    def set_image(self, image_data, view_mode):
        self.current_image = image_data
        self.view_mode = view_mode

        if view_mode == 1:
            img = image_data.image.copy()
        elif view_mode == 2:
            img = image_data.image.copy()
            if img.dtype == np.uint16:
                img = (img / 256).astype(np.uint8)
            mask = image_data.mask
            img[mask > 0] = (0, 0, 255)
        else:
            img = image_data.inpainted.copy()

        self.display_img = img
        self.show_image(img)

    def show_image(self, img):
        # Handle 16-bit images
        if img.dtype == np.uint16:
            img = (img / 256).astype(np.uint8)

        h, w, _ = img.shape

        # Add watermark text for DEMO
        text = 'FILMOMATFILMOMATFILMOMATFILMOMATFILMOMATFILMOMATFILMOMATFILMOMATFILMOMATFILMOMATFILMOMATFILMOMAT'
        position1 = (0, int(h / 8))
        position2 = (0, int(h / 4))
        position3 = (0, int(h / 6))
        font = cv2.FONT_HERSHEY_SIMPLEX
        font_scale = 2
        font_color = (255, 0, 255)
        font_thickness = 20

        overlay = img.copy()
        cv2.putText(overlay, text, position1, font, font_scale, font_color, font_thickness, cv2.LINE_AA)
        cv2.putText(overlay, text, position2, font, font_scale, font_color, font_thickness, cv2.LINE_AA)
        cv2.putText(overlay, text, position3, font, font_scale, font_color, font_thickness, cv2.LINE_AA)

        opacity = 0.3
        output = cv2.addWeighted(overlay, opacity, img, 1 - opacity, 0)

        # Convert BGR to RGB
        rgb = cv2.cvtColor(output, cv2.COLOR_BGR2RGB)
        h, w, ch = rgb.shape
        bytes_per_line = ch * w

        new_size = QSize(int(w * self.zoom_factor), int(h * self.zoom_factor))
        q_img = QImage(rgb.data, w, h, bytes_per_line, QImage.Format.Format_RGB888)

        self.pixmap = QPixmap.fromImage(q_img)
        self.pixmap = self.pixmap.scaled(
            new_size,
            Qt.AspectRatioMode.KeepAspectRatio,
            Qt.TransformationMode.SmoothTransformation
        )
        self.scaled_pixmap = self.pixmap
        self.setPixmap(self.scaled_pixmap)
        self.resize(self.scaled_pixmap.size())
        self.updateGeometry()

    def sizeHint(self):
        if self.scaled_pixmap:
            return self.scaled_pixmap.size()
        return super().sizeHint()

    def update_display(self):
        base_image = self.scaled_pixmap.toImage()
        base_image = base_image.convertToFormat(QImage.Format.Format_ARGB32)

        painter = QPainter(base_image)
        painter.drawImage(0, 0, self.overlay)
        painter.end()

        self.setPixmap(QPixmap.fromImage(base_image))

    def wheelEvent(self, event):
        delta = event.angleDelta().y()
        mod = event.modifiers()

        if mod == Qt.KeyboardModifier.AltModifier:
            # Zoom
            scroll_area = self.parentWidget()
            if isinstance(scroll_area, QScrollArea):
                h_bar = scroll_area.horizontalScrollBar()
                v_bar = scroll_area.verticalScrollBar()

                center_x = h_bar.value() + scroll_area.viewport().width() / 2
                center_y = v_bar.value() + scroll_area.viewport().height() / 2

                center_ratio_x = center_x / self.width() if self.width() > 0 else 0.5
                center_ratio_y = center_y / self.height() if self.height() > 0 else 0.5

                if delta > 0:
                    zoom_in = True
                    factor = 1.1
                else:
                    zoom_in = False
                    factor = 0.9090909090909091

                self.zoom_factor = max(0.05, min(self.zoom_factor * factor, 1.0))

                if self.display_img is not None:
                    self.show_image(self.display_img)

                    new_w = self.width()
                    new_h = self.height()
                    new_center_x = center_ratio_x * new_w
                    new_center_y = center_ratio_y * new_h

                    h_bar.setValue(int(new_center_x - scroll_area.viewport().width() / 2))
                    v_bar.setValue(int(new_center_y - scroll_area.viewport().height() / 2))

        elif mod == Qt.KeyboardModifier.ControlModifier:
            # Adjust brush radius
            if delta > 0:
                self.brush_radius = self.brush_radius + 1
            else:
                self.brush_radius = max(1, self.brush_radius - 1)
            self.setCursor(self.create_circle_cursor(QColor(255, 0, 255)))
        else:
            # Pass scroll to scroll area
            scroll_area = self.parentWidget()
            if isinstance(scroll_area, QScrollArea):
                v_bar = scroll_area.verticalScrollBar()
                self.wheel_counter = self.wheel_counter + delta
                if delta > 0:
                    v_bar.setValue(v_bar.value() - 2 * self.wheel_counter)
                else:
                    v_bar.setValue(v_bar.value() - 2 * self.wheel_counter)
                self.wheel_counter = 0
            event.ignore()

    def mousePressEvent(self, event):
        if self.current_image is None:
            return
        if self.view_mode != 2:
            return

        self.drawing = True
        pos = QPoint(int(event.pos().x()), int(event.pos().y()))
        self.last_pos = pos

        mods = event.modifiers()

        if mods == Qt.KeyboardModifier.AltModifier:
            self.mode = 'direct'
        elif mods == Qt.KeyboardModifier.ShiftModifier:
            self.mode = 'remove'
        else:
            self.mode = 'intelligent'

        # Create fresh overlay
        self.overlay = QImage(self.scaled_pixmap.size(), QImage.Format.Format_ARGB32)
        self.overlay.fill(Qt.GlobalColor.transparent)

        # Draw initial dot
        painter = QPainter(self.overlay)
        if self.mode == 'direct':
            color = QColor(255, 0, 0, 100)
        elif self.mode == 'remove':
            color = QColor(0, 0, 255, 100)
        else:
            color = QColor(255, 255, 0, 100)
        painter.setBrush(color)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.drawEllipse(pos, self.brush_radius, self.brush_radius)
        painter.end()

        self.update_display()

    def mouseMoveEvent(self, event):
        if not self.drawing:
            return
        if self.current_image is None:
            return
        if self.display_img is None:
            return
        if self.view_mode != 2:
            return

        corr_pos = QPoint(int(event.pos().x()), int(event.pos().y()))

        painter = QPainter(self.overlay)
        if self.mode == 'direct':
            color = QColor(255, 0, 0, 100)
        elif self.mode == 'intelligent':
            color = QColor(255, 255, 0, 100)
        else:
            color = QColor(0, 0, 255, 100)

        pen = QPen(color, self.brush_radius * 2, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap)
        painter.setPen(pen)
        painter.drawLine(self.last_pos, corr_pos)
        self.last_pos = corr_pos
        painter.end()

        self.update_display()

    def mouseReleaseEvent(self, event):
        self.drawing = False
        if self.current_image is None:
            return
        if self.view_mode != 2:
            return

        # Scale overlay to mask size
        overlay_scaled = self.overlay.scaled(
            self.current_image.mask.shape[1],
            self.current_image.mask.shape[0],
            Qt.AspectRatioMode.KeepAspectRatio
        )
        overlay_array = self.qimage_to_array(overlay_scaled, self.current_image.mask.shape)

        if self.mode == 'intelligent':
            # Get gray image
            gray = cv2.cvtColor(self.current_image.image, cv2.COLOR_BGR2GRAY)
            if gray.dtype == np.uint16:
                gray = (gray / 256).astype(np.uint8)

            # Find bounding rect of the drawn area
            x, y, w, h = cv2.boundingRect(overlay_array)
            cropped_image = gray[y:y+h, x:x+w]

            # Scharr edge detection on cropped region
            diff_x = cv2.Scharr(cropped_image, cv2.CV_64F, 1, 0)
            diff_y = cv2.Scharr(cropped_image, cv2.CV_64F, 0, 1)
            scharr = np.sqrt(diff_x * diff_x + diff_y * diff_y)
            scharr = cv2.normalize(scharr, None, 0, 255, cv2.NORM_MINMAX, cv2.CV_8U)
            scharr = cv2.inRange(scharr, 0, 60)
            scharr = cv2.GaussianBlur(scharr, (0, 0), 1)

            # Find contours in the edge-detected region
            contours, _ = cv2.findContours(scharr, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            filled = np.zeros_like(scharr, dtype=np.uint8)
            cv2.drawContours(filled, contours, -1, 255, cv2.FILLED)

            # Place back into full-size mask
            edges_full = np.zeros_like(gray, dtype=np.uint8)
            edges_full[y:y+h, x:x+w] = filled

            # Combine with overlay area
            selection = cv2.bitwise_and(edges_full, overlay_array)
            self.current_image.mask = cv2.bitwise_or(self.current_image.mask, selection)

        elif self.mode == 'direct':
            self.current_image.mask = cv2.bitwise_or(self.current_image.mask, overlay_array)

        elif self.mode == 'remove':
            self.current_image.mask = cv2.bitwise_and(
                self.current_image.mask, cv2.bitwise_not(overlay_array)
            )

        # Re-inpaint
        self.current_image.inpaint_image()
        self.current_image.inpainted = self.current_image.inpainted

        # Clear overlay
        self.overlay.fill(Qt.GlobalColor.transparent)

        # Refresh display
        self.drawing = False
        self.set_image(self.current_image, self.view_mode)

    def qimage_to_array(self, qimage, target_shape):
        ptr = qimage.bits()
        ptr.setsize(qimage.width() * qimage.height() * 4)
        arr = np.frombuffer(ptr, np.uint8).reshape(qimage.height(), qimage.width(), 4)

        # Extract alpha channel as mask
        alpha_mask = arr[:, :, 3]
        alpha_mask = cv2.inRange(alpha_mask, 1, 255)

        # Resize to target shape
        resized = cv2.resize(alpha_mask, (target_shape[1], target_shape[0]),
                             interpolation=cv2.INTER_NEAREST)
        return resized.astype(np.uint8)

    def focusInEvent(self, event):
        super().focusInEvent(event)


class ExportDialog(QDialog):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle('Export Images')

        self.desc = QLabel('Choose files to export.')
        self.desc.setAlignment(Qt.AlignmentFlag.AlignCenter)

        self.image_button = QCheckBox('Retouched Image')
        self.image_button.setCheckable(True)
        self.image_button.setChecked(True)

        self.mask_button = QCheckBox('Retouch mask (Full version only)')
        self.mask_button.setCheckable(True)
        self.mask_button.setChecked(False)

        layout = QGridLayout()
        layout.addWidget(self.desc, 0, 0)
        layout.addWidget(self.image_button, 1, 0)
        layout.addWidget(self.mask_button, 2, 0)

        buttonBox = QPushButton('OK')
        buttonBox.clicked.connect(self.accept)
        layout.addWidget(buttonBox, 3, 0)

        self.setLayout(layout)

    def get_selection(self):
        image = self.image_button.isChecked()
        mask = self.mask_button.isChecked()
        return image, mask


class NewsDialog(QDialog):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle('New in version ' + current_version)

        message = '- Fixed wrong colors in TIFF export.\n\n- Enabled changing strength of multiple images at once.\n\n'

        self.desc = QLabel(message)
        self.desc.setAlignment(Qt.AlignmentFlag.AlignLeft)

        layout = QGridLayout()
        layout.addWidget(self.desc, 0, 0)
        self.setLayout(layout)


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()

        # Setup data directory
        app_data_dir = user_data_dir('Dustomat')
        data_file_path = os.path.join(app_data_dir, 'license.json')
        settings_file_path = os.path.join(app_data_dir, 'settings.json')

        self.app_unlocked = False

        if not os.path.exists(app_data_dir):
            os.makedirs(app_data_dir)

        # Load settings
        try:
            with open(settings_file_path, 'r') as file:
                data = json.load(file)
                version = data.get('version')
        except:
            version = None

        if version != current_version:
            with open(settings_file_path, 'w') as file:
                json.dump({'version': current_version}, file)
            msgBox = NewsDialog(self)
            msgBox.exec()

        self.setWindowTitle('Dustomat ' + current_version + ' - DEMO ')

        # Set window icon
        if hasattr(sys, '_MEIPASS'):
            image_path = sys._MEIPASS + '/' + 'Icon.png'
        else:
            image_path = 'Icon.png'
        self.app = QApplication.instance()
        self.app.setWindowIcon(QIcon(image_path))

        # Thread pool
        self.thread_pool = QThreadPool.globalInstance()
        self.thread_pool.setMaxThreadCount(4)

        # Menu bar
        menubar = self.menuBar()
        version_menu = menubar.addMenu('Version ' + current_version)
        licenses = QAction('Licenses', self)
        licenses.triggered.connect(self.licenses)
        version_menu.addAction(licenses)

        # State
        self.email = None
        self.images = []
        self.current_index = 0
        self.view_mode = 2
        self.setGeometry(100, 100, 1100, 800)
        self.statusBar().show()

        # Layout
        main_layout = QHBoxLayout()

        # Canvas
        self.canvas = ImageCanvas()
        self.scroll_area = QScrollArea()
        self.scroll_area.setWidget(self.canvas)
        self.scroll_area.setWidgetResizable(True)
        self.scroll_area.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOn)
        self.scroll_area.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOn)
        main_layout.addWidget(self.scroll_area, 3)
        self.canvas.clear()

        # Side panel
        side_panel = QVBoxLayout()

        description = QLabel('\n\t\t<b>Keyboard Controls:</b><br>\n\t\t&bull; 1: Raw image<br>\n\t\t&bull; 2: Masked image view<br>\n\t\t&bull; 3: Retouched image<br>\n\t\t&bull; Enter: Next image<br><br>\n\n\t\t<b>Mouse Controls:</b><br>\n\t\t&bull; Mouse Wheel + Alt: Zoom.<br>\n\t\t&bull; Mouse Wheel + Ctrl: Adjust brush size.<br>\n\t\t&bull; Mouse Wheel only: Move Image.<br>\n\t\t&bull; Click/Draw: Intelligent Retouch.<br>\n\t\t&bull; Click/Draw + Alt: Direct Retouch.<br>\n\t\t&bull; Click/Draw + Shift: Remove Retouch.<br>\n\t\t')
        description.setWordWrap(True)
        side_panel.addWidget(description)

        # Image list
        self.list_widget = QListWidget()
        self.list_widget.currentRowChanged.connect(self.change_image)
        self.list_widget.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        side_panel.addWidget(self.list_widget)

        # Strength slider
        self.strength_label = QLabel('Strength:')
        side_panel.addWidget(self.strength_label)

        self.strength_slider = QSlider(Qt.Orientation.Horizontal)
        self.strength_slider.setRange(1, 10)
        self.strength_slider.setValue(3)
        self.strength_slider.setTickPosition(QSlider.TickPosition.TicksBelow)
        self.strength_slider.setTickInterval(1)
        self.strength_slider.valueChanged.connect(self.apply_strength_to_selection)
        side_panel.addWidget(self.strength_slider)

        # Buttons
        clear_btn = QPushButton('Clear Images')
        clear_btn.clicked.connect(self.clear_images)
        side_panel.addWidget(clear_btn)

        export_btn = QPushButton('Export Images')
        export_btn.clicked.connect(self.export_images)
        side_panel.addWidget(export_btn)

        main_layout.addLayout(side_panel)

        # Set central widget
        container = QWidget()
        container.setLayout(main_layout)
        self.setCentralWidget(container)

        self.setAcceptDrops(True)
        self.canvas.setFocusPolicy(Qt.FocusPolicy.NoFocus)

    def licenses(self):
        msgBox = LicenseDialog(self)
        msgBox.exec()

    def unlock(self):
        popup = LicensePopup(self)
        popup.move(self.geometry().center() - popup.frameGeometry().center())
        popup.exec()
        self.email = popup.get_email()

    def dragEnterEvent(self, event):
        if event.mimeData().hasUrls():
            event.acceptProposedAction()

    def dropEvent(self, event):
        paths = []
        for url in event.mimeData().urls():
            path = url.toLocalFile()
            if path.lower().endswith(('.png', '.jpg', '.jpeg', '.tif', '.tiff')):
                paths.append(path)
        self.process_images(paths)

    def process_images(self, file_paths):
        self.progress_dialog = QProgressDialog(
            'Analyzing Images\nThis will take about 1-4 seconds per image.',
            'Cancel',
            0,
            len(file_paths)
        )
        self.progress_dialog.setWindowModality(Qt.WindowModality.WindowModal)
        self.progress_dialog.setAutoClose(True)
        self.progress_dialog.setFixedSize(400, 200)
        self.progress_dialog.setValue(0)

        self.remaining = len(file_paths)
        self.processed = 0

        for path in file_paths:
            task = ImageTask(path)
            task.signals.finished.connect(self.addProcessedImages)
            self.thread_pool.start(task)

        self.progress_dialog.exec()

    def addProcessedImages(self, image_data):
        self.images.append(image_data)
        item = QListWidgetItem(os.path.basename(image_data.path))
        self.list_widget.addItem(item)

        self.processed = self.processed + 1
        self.progress_dialog.setValue(self.processed)
        self.remaining = self.remaining - 1

        if self.remaining == 0:
            self.progress_dialog.close()

        if len(self.images) > 0:
            self.list_widget.setCurrentRow(0)

    def change_image(self, index):
        if index < 0 or index >= len(self.images):
            return
        self.current_index = index
        self.canvas.set_image(self.images[index], self.view_mode)
        self.strength_slider.setValue(self.images[index].strength)

    def apply_strength_to_selection(self, value):
        selected_items = self.list_widget.selectedItems()
        for item in selected_items:
            index = self.list_widget.row(item)
            image_data = self.images[index]
            current_strength = image_data.strength
            if value != current_strength:
                image_data.update_strength(value)
        self.canvas.set_image(self.images[self.current_index], self.view_mode)

    def update_strength(self, value):
        img = self.images[self.current_index]
        current_strength = img.strength
        if value != current_strength:
            img.update_strength(value)
        self.canvas.set_image(self.images[self.current_index], self.view_mode)

    def keyPressEvent(self, event):
        if len(self.images) == 0:
            return

        if event.key() == Qt.Key.Key_1:
            self.view_mode = 1
            self.statusBar().showMessage('Raw Image')
            self.canvas.set_image(self.images[self.current_index], 1)
        elif event.key() == Qt.Key.Key_2:
            self.view_mode = 2
            self.statusBar().showMessage('Detected Dust particles')
            self.canvas.set_image(self.images[self.current_index], 2)
        elif event.key() == Qt.Key.Key_3:
            self.view_mode = 3
            self.statusBar().showMessage('Corrected Image')
            self.canvas.set_image(self.images[self.current_index], 3)
        elif event.key() == Qt.Key.Key_Down:
            if self.current_index < len(self.images) - 1:
                self.change_image(self.current_index + 1)
                self.list_widget.setCurrentRow(self.current_index)
        elif event.key() == Qt.Key.Key_Up:
            if self.current_index > 0:
                self.change_image(self.current_index - 1)
                self.list_widget.setCurrentRow(self.current_index)
        elif event.key() == Qt.Key.Key_Return:
            if self.current_index < len(self.images) - 1:
                self.change_image(self.current_index + 1)
                self.list_widget.setCurrentRow(self.current_index)

    def clear_images(self):
        self.images.clear()
        self.list_widget.clear()
        self.canvas.clear()
        self.statusBar().clearMessage()

    def export_images(self):
        if not self.images:
            return

        folder = QFileDialog.getExistingDirectory(self, 'Select Export Folder')
        if not folder:
            return

        dialog = ExportDialog(self)
        result = dialog.exec()
        if not result:
            return

        selection = dialog.get_selection()

        masks_dir = os.path.join(folder, 'Masks')
        if selection[1]:
            os.makedirs(masks_dir, exist_ok=True)

        progress_dialog = QProgressDialog(
            'Exporting Images\nThis will take about 1-2 seconds per image.',
            'Cancel',
            0,
            len(self.images)
        )
        progress_dialog.setWindowModality(Qt.WindowModality.WindowModal)
        progress_dialog.setAutoClose(True)
        progress_dialog.setFixedSize(400, 200)
        progress_dialog.setValue(0)
        progress_dialog.show()

        for i, img in enumerate(self.images):
            if progress_dialog.wasCanceled():
                break

            base, _ = os.path.splitext(os.path.basename(img.path))

            if selection[0]:
                # Export corrected image with watermark (DEMO)
                text = 'FILMOMATFILMOMATFILMOMATFILMOMATFILMOMATFILMOMATFILMOMATFILMOMATFILMOMATFILMOMATFILMOMATFILMOMAT'
                h, w, _ = img.inpainted.shape

                position1 = (0, int(h / 8))
                position2 = (0, int(h / 3))
                position3 = (0, int(h / 4))
                position4 = (0, int(h / 5))
                position5 = (0, int(h / 6))
                position6 = (0, int(h / 7))
                font = cv2.FONT_HERSHEY_SIMPLEX
                font_scale = 2
                font_color = (0, 0, 255)
                font_thickness = 20

                overlay = img.inpainted.copy()
                cv2.putText(overlay, text, position1, font, font_scale, font_color, font_thickness, cv2.LINE_AA)
                cv2.putText(overlay, text, position2, font, font_scale, font_color, font_thickness, cv2.LINE_AA)
                cv2.putText(overlay, text, position3, font, font_scale, font_color, font_thickness, cv2.LINE_AA)
                cv2.putText(overlay, text, position4, font, font_scale, font_color, font_thickness, cv2.LINE_AA)
                cv2.putText(overlay, text, position5, font, font_scale, font_color, font_thickness, cv2.LINE_AA)
                cv2.putText(overlay, text, position6, font, font_scale, font_color, font_thickness, cv2.LINE_AA)

                opacity = 0.3
                output = cv2.addWeighted(overlay, opacity, img.inpainted, 1 - opacity, 0)

                # Convert and save
                img_rgb = cv2.cvtColor(output, cv2.COLOR_BGR2RGB)
                if img.grayscale:
                    img_rgb = cv2.cvtColor(output, cv2.COLOR_BGR2GRAY)

                if img.inpainted.dtype == np.uint16:
                    cv2.imwrite(os.path.join(folder, base + '_corrected.tif'), output)
                else:
                    img_pil_out = Image.fromarray(img_rgb)
                    img_pil_out.save(
                        os.path.join(folder, base + '_corrected.jpg'),
                        format='JPEG',
                        quality=100,
                        icc_profile=img.icc_profile
                    )

            progress_dialog.setValue(i + 1)
            QApplication.processEvents()

        progress_dialog.close()


class LicenseDialog(QDialog):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle('Licenses')

        LICENSE_TEXT = """
1. OpenCV (Apache 2.0 License)

Copyright (c) 2024 OpenCV Foundation

http://www.apache.org/licenses/

Licensed under the Apache License, Version 2.0.
You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0

2. NumPy (BSD License)

Copyright (c) 2005-2024, NumPy Developers.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met.

3. Pillow (HPND License)

The Python Imaging Library (PIL) is
Copyright (c) 1997-2011 by Secret Labs AB
Copyright (c) 1995-2011 by Fredrik Lundh and Contributors.

4. PyQt6 (GPL v3 License)

Copyright (c) Riverbank Computing Limited.
Licensed under the GNU General Public License v3.
"""

        layout = QVBoxLayout()
        label = QLabel('Licenses')
        layout.addWidget(label)

        text_edit = QTextEdit()
        text_edit.setText(LICENSE_TEXT)
        text_edit.setReadOnly(True)
        layout.addWidget(text_edit)

        buttonBox = QPushButton('OK')
        buttonBox.clicked.connect(self.accept)
        layout.addWidget(buttonBox)

        self.setLayout(layout)


if __name__ == '__main__':
    app = QApplication(sys.argv)
    window = MainWindow()
    window.show()
    sys.exit(app.exec())
