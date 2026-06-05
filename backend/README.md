# SpritePet 后端

此后端为可选组件。前端作为静态 GitHub Pages 应用可独立运行，无需后端。

仅在需要本地视频转精灵功能时启动后端。

## 环境配置

```bash
cd backend
uv venv
source .venv/bin/activate
uv pip install -r requirements.txt
```

系统还需安装 `ffmpeg` 和 `ffprobe` 并确保它们在 PATH 中。

## 启动

```bash
./start.sh
```

默认地址：

```text
http://127.0.0.1:8003
```

上传 API 会将生成的精灵图片和元数据写入：

```text
../public/sprites
```

## API

- `GET /api/health` — 健康检查
- `GET /api/sprites` — 获取精灵列表
- `POST /api/upload` — 上传视频
- `GET /api/task/<taskId>` — 查询任务状态
- `GET /api/sprites/<name>/metadata` — 获取精灵元数据
- `POST /api/calibration/<name>` — 保存精灵校准数据

网页上传路径使用 MPS BiRefNet 管道。CPU/rembg 命令行工具位于 `scripts/build_cat_sprite.py`。
