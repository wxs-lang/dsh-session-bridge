"""
生成 DeepSeek 鲸鱼图标（扩展用）

源图：https://www.deepseek.com/favicon.ico 里最大的 225x225 帧
      主色 #4D6BFE（77,107,254）

输出两套：
  icons/icon{16,32,48,64,128}.png       白天：鲸鱼本来的蓝
  icons/dark/icon{16,32,48,64,128}.png  夜间：纯黑剪影

都是透明背景，鲸鱼占满画布（Chrome 会自己加内边距）。

  python make-icons.py
"""
from PIL import Image
import os

HERE = os.path.dirname(os.path.abspath(__file__))
# 源图放在扩展目录之外：Chrome 拒绝加载任何以下划线开头的文件/目录，
# 所以 extension/icons/ 下不能有 _src。路径从 icons/ 往上两级再进 icon-src。
SRC = os.path.join(os.path.dirname(os.path.dirname(HERE)), "icon-src", "from-ico.png")
DARK_DIR = os.path.join(HERE, "dark")
os.makedirs(DARK_DIR, exist_ok=True)

BLUE = (77, 107, 254)
BLACK = (0, 0, 0)

SIZES = [16, 32, 48, 64, 128]


def load_master() -> Image.Image:
    """载入源图，裁到内容边界，缩放到 1024 见方的母版。"""
    im = Image.open(SRC).convert("RGBA")
    bbox = im.getbbox()
    if bbox:
        im = im.crop(bbox)

    # 补成正方形（居中）
    w, h = im.size
    side = max(w, h)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(im, ((side - w) // 2, (side - h) // 2), im)
    # 超大画布保证缩放质量
    return canvas.resize((1024, 1024), Image.LANCZOS)


def recolor(master: Image.Image, rgb) -> Image.Image:
    """把整条鲸鱼改成单一颜色，保留 alpha 形状（含眼睛的镂空）。"""
    px = master.load()
    out = Image.new("RGBA", master.size, (0, 0, 0, 0))
    op = out.load()
    for y in range(master.size[1]):
        for x in range(master.size[0]):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            op[x, y] = (rgb[0], rgb[1], rgb[2], a)
    return out


def main():
    master = load_master()
    print("master:", master.size)

    # 白天：原色（已经就是 #4D6BFE，直接用）
    day = master
    # 夜间：纯黑剪影
    night = recolor(master, BLACK)

    for s in SIZES:
        p = os.path.join(HERE, f"icon{s}.png")
        day.resize((s, s), Image.LANCZOS).save(p, "PNG", optimize=True)
        print(f"{p}  {s}x{s}  {os.path.getsize(p)} bytes")

    for s in SIZES:
        p = os.path.join(DARK_DIR, f"icon{s}.png")
        night.resize((s, s), Image.LANCZOS).save(p, "PNG", optimize=True)
        print(f"{p}  {s}x{s}  {os.path.getsize(p)} bytes")

    # 预览
    big_day = day.resize((256, 256), Image.LANCZOS)
    big_night = night.resize((256, 256), Image.LANCZOS)
    lhs = os.path.join(HERE, "preview256.png")
    rhs = os.path.join(DARK_DIR, "preview256.png")
    big_day.save(lhs, "PNG")
    big_night.save(rhs, "PNG")

    # 拼一张对照图给用户看（白底 + 深底）
    sheet = Image.new("RGBA", (560, 300), (255, 255, 255, 255))
    sheet.paste(big_day, (24, 22), big_day)
    dark_panel = Image.new("RGBA", (256, 256), (24, 24, 28, 255))
    dark_panel.paste(big_night, (0, 0), big_night)
    sheet.paste(dark_panel, (296, 22), dark_panel)
    sheet.save(os.path.join(HERE, "preview-both.png"), "PNG")

    # 工作区留一份
    ws = r"F:\Migrated\D\人格\文档\dsh-computer-use-demo"
    if os.path.isdir(ws):
        sheet.save(os.path.join(ws, "06-图标-白天与夜间.png"), "PNG")
        print("workspace copy ok")

    print("\n预览:", os.path.join(HERE, "preview-both.png"))


if __name__ == "__main__":
    main()
