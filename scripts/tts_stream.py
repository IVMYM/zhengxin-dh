"""edge-tts 流式合成：把 MP3 数据块持续写到 stdout，逐词时间戳写到 stderr。
用法：python3 tts_stream.py <voice> <rate> <pitch>  （文本从 stdin 读取）
stderr 中每个词一行：WB<TAB>{"t": 起始秒, "d": 时长秒, "w": "词"}，供字幕与口型对齐。
"""
import asyncio
import json
import sys

import edge_tts


async def main() -> None:
    voice, rate, pitch = sys.argv[1], sys.argv[2], sys.argv[3]
    text = sys.stdin.read().strip()
    out = sys.stdout.buffer
    err = sys.stderr
    communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, boundary="WordBoundary")
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            out.write(chunk["data"])
            out.flush()
        elif chunk["type"] == "WordBoundary":
            # edge-tts 的 offset / duration 单位是 100 纳秒
            item = {"t": round(chunk["offset"] / 1e7, 3), "d": round(chunk["duration"] / 1e7, 3), "w": chunk["text"]}
            err.write("WB\t" + json.dumps(item, ensure_ascii=False) + "\n")
            err.flush()


if __name__ == "__main__":
    asyncio.run(main())
