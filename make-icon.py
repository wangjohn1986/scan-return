# 產生「未取貨」白字綠底 App 圖示（垂直排列，maskable 安全區內）
import os
from PIL import Image, ImageDraw, ImageFont

GREEN = (22, 163, 74)     # #16a34a
WHITE = (255, 255, 255)
FONT_PATH = r"C:\Windows\Fonts\msjhbd.ttc"  # 微軟正黑體 Bold
CHARS = "未取貨"
BASE = os.path.dirname(os.path.abspath(__file__))


def make(size, out):
    img = Image.new("RGB", (size, size), GREEN)
    d = ImageDraw.Draw(img)
    margin = int(size * 0.13)              # maskable 安全邊
    avail = size - 2 * margin
    n = len(CHARS)
    cell = avail / n                       # 垂直三等分
    fs = int(cell * 0.92)                  # 每字約佔滿一格
    font = ImageFont.truetype(FONT_PATH, fs, index=0)
    cx = size / 2                          # 水平正中
    for i, c in enumerate(CHARS):
        cy = margin + cell * (i + 0.5)     # 每格垂直正中
        d.text((cx, cy), c, font=font, fill=WHITE, anchor="mm")
    img.save(out)
    print("wrote", out, "fontsize", fs)


make(192, os.path.join(BASE, "icon-192.png"))
make(512, os.path.join(BASE, "icon-512.png"))
