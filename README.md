# SpritePet

SpritePet 是一个前端优先的工具，用于预览、校准和可选地生成动画宠物精灵图集（sprite sheet）。

它加载精灵图片及对应的 JSON 元数据文件，然后将鼠标指针方向映射到精灵帧。预览和校准 UI 使用 Vite、React 和 TypeScript 构建，可直接部署到 GitHub Pages。当需要视频转精灵功能时，可以启动本地 Python 后端。

## 演示

![演示](demo.mp4)

## 功能特性

- 预览透明 WebP 精灵图集
- 在预置的宠物精灵之间切换
- 通过鼠标指针方向驱动精灵帧
- 编辑中心点、角度到帧的映射关系以及选中的帧
- 导出校准 JSON
- 尝试可选的光标样式
- 可选的本地视频转精灵转换器，位于 `#/convert`

## 开发

```bash
npm install
npm run dev
```

打开：

```text
http://127.0.0.1:5173/
```

转换器页面访问地址：

```text
http://127.0.0.1:5173/#/convert
```

## 可选后端

前端无需后端即可正常工作。仅在需要本地转换视频时启动后端。

后端可以将一段视频中的主体（如宠物）抠出并自动生成精灵图集（sprite sheet）：它会逐帧提取主体、去除背景并合成一张透明 WebP 精灵图，同时输出对应的帧映射 JSON 文件。

```bash
cd backend
uv venv
source .venv/bin/activate
uv pip install -r requirements.txt
./start.sh
```

默认后端地址：

```text
http://127.0.0.1:8003
```

后端生成的精灵图片和元数据会写入 `public/sprites` 目录。如果使用不同的后端地址，请设置：

```bash
VITE_BACKEND_URL=http://127.0.0.1:8003 npm run dev
```

## 验证

```bash
npm test
npm run lint
npm run build
npm run verify:page
```

## GitHub Pages

Vite 的 base path 已配置为仓库名 `sprite-pet`。

```bash
npm run deploy
```

然后使用你偏好的 GitHub Pages 工作流发布生成的 `dist` 目录。

## 精灵资源

将精灵配对文件放入 `public/sprites` 目录：

```text
cat-sprite.webp
cat-sprite.json
```

每个 JSON 文件应包含帧尺寸、网格列数/行数、帧数、图片文件名以及可选的校准数据。
