// HoughLinesP は OpenCV 4/5 で N×1 と 1×N の両方を返す。
// 各線分は CV_32SC4 (x1, y1, x2, y2) なので rows に依存しない。
export function houghLineCount(lines) {
  return Math.floor((lines?.data32S?.length || 0) / 4);
}
