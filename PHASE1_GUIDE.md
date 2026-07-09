# Phase 1：CLI 原型開發指引

>（歷史文件：以下描述 Phase 1 的 zh→en+vi 固定管線；現版本已多語化，見 docs/ADD_LANGUAGE.md）

**目標**：在投入桌面版開發前，先用最少程式碼驗證整條 pipeline 的延遲與翻譯品質。

## 驗收標準

執行 `python prototype/cli.py` 後：

1. 對著麥克風講一句中文（5-10 秒）
2. 終端應在說話結束後 **2.5 秒內** 開始輸出英文譯文
3. 譯文應在 **5 秒內** 完成
4. 越南文同上
5. 連續講 5 句話不應 crash 或記憶體爆炸

## 實作順序

### Step 1：環境準備
```bash
cd prototype
python -m venv .venv
source .venv/bin/activate
pip install faster-whisper silero-vad sounddevice numpy anthropic python-dotenv
```

建立 `.env`：
```
ANTHROPIC_API_KEY=sk-ant-...
```

### Step 2：先跑通 Whisper（不接麥克風）
寫一個最簡單的腳本，讀 `samples/zh_short.wav`，用 `faster-whisper` 轉文字，印出結果與耗時。

驗證：Mac M 系列跑 `large-v3-turbo`，5 秒音檔應在 1 秒內完成。

### Step 3：接上 Claude API
把 Step 2 的中文輸出送進 Claude Haiku，streaming 印譯文。

驗證：第一個 token 應在 500ms 內出現。

### Step 4：並行翻譯
用 `asyncio.gather` 同時送中→英、中→越兩個請求。

驗證：兩邊都在 streaming 狀態，不互相阻塞。

### Step 5：接麥克風 + VAD
用 `sounddevice` 持續錄音，用 `silero-vad` 偵測語音段落，每段送 Whisper。

VAD 參數調校建議：
- `threshold`: 0.5（太低會誤觸，太高會漏字）
- `min_silence_duration_ms`: 300（句尾停頓判定，速度優先；若切太碎再調回 400）
- `min_speech_duration_ms`: 250（過濾雜音）

### Step 6：串起完整 pipeline
mic → VAD → Whisper → 並行翻譯 → 終端輸出（三欄：中 / 英 / 越）

### Step 7：延遲量測
寫 `latency_bench.py`：
- 標記時間點 T0（VAD 偵測到 speech_end）
- T1（Whisper 完成）
- T2（Claude 第一 token）
- T3（Claude 完成）
- 連續錄 10 句，輸出 P50 / P95

## 關鍵程式片段

### `stt.py` 核心
```python
from faster_whisper import WhisperModel

class WhisperSTT:
    def __init__(self, model_size="large-v3-turbo", device="auto"):
        # Mac M 系列用 "auto" 會自動選 CoreML
        self.model = WhisperModel(
            model_size,
            device=device,
            compute_type="int8" if device == "cpu" else "float16"
        )
    
    def transcribe(self, audio_np):
        segments, _ = self.model.transcribe(
            audio_np,
            language="zh",
            beam_size=1,           # 速度優先
            vad_filter=False,      # 我們自己用 silero-vad
            condition_on_previous_text=False,  # 避免上下文污染
        )
        return "".join(seg.text for seg in segments).strip()
```

### `translator.py` 核心
```python
import anthropic
import asyncio

SYSTEM_PROMPT = """你是專業即時會議口譯員。將使用者輸入的中文翻譯為 {target_lang}。
規則：
1. 只輸出譯文，不要任何解釋、引號、標點修飾
2. 保留專有名詞原文（公司名、產品名、人名）
3. 口語化但專業，符合會議場合"""

LANG_MAP = {"en": "English", "vi": "Vietnamese (Tiếng Việt)"}

class Translator:
    def __init__(self):
        self.client = anthropic.AsyncAnthropic()
    
    async def translate_stream(self, text, target):
        async with self.client.messages.stream(
            model="claude-haiku-4-5",
            max_tokens=1024,
            system=[{
                "type": "text",
                "text": SYSTEM_PROMPT.format(target_lang=LANG_MAP[target]),
                "cache_control": {"type": "ephemeral"}  # 快取 system
            }],
            messages=[{"role": "user", "content": text}]
        ) as stream:
            async for chunk in stream.text_stream:
                yield chunk
    
    async def translate_both(self, text, on_chunk):
        async def run(target):
            async for chunk in self.translate_stream(text, target):
                on_chunk(target, chunk)
        await asyncio.gather(run("en"), run("vi"))
```

### `cli.py` 主迴圈
```python
import asyncio
from audio_capture import AudioStream
from vad import VADProcessor
from stt import WhisperSTT
from translator import Translator

async def main():
    stt = WhisperSTT()
    translator = Translator()
    vad = VADProcessor()
    
    print("🎤 開始錄音，按 Ctrl+C 停止")
    
    async with AudioStream() as audio:
        async for speech_chunk in vad.process(audio):
            # speech_chunk 是一段完整的語音 numpy array
            zh_text = stt.transcribe(speech_chunk)
            if not zh_text:
                continue
            
            print(f"\n[中] {zh_text}")
            
            def on_chunk(target, chunk):
                # 即時印出，不換行
                prefix = "[英]" if target == "en" else "[越]"
                print(f"{prefix} {chunk}", end="", flush=True)
            
            await translator.translate_both(zh_text, on_chunk)
            print()  # 翻譯完換行

if __name__ == "__main__":
    asyncio.run(main())
```

## 常見坑

1. **Mac 麥克風權限**：第一次跑會跳權限視窗，要在「系統設定 → 隱私 → 麥克風」勾終端機
2. **Whisper 模型下載**：首次跑會自動下載到 `~/.cache/huggingface/`，約 1.5GB
3. **silero-vad 取樣率**：必須是 16000 Hz，麥克風 capture 時就要 resample
4. **asyncio + sounddevice**：sounddevice 的 callback 是同步的，要用 `asyncio.Queue` 橋接到 async 世界
5. **長句處理**：如果使用者連續講超過 8 秒不停頓，VAD 不會切，要設 `max_speech_sec` 強制切片

## 完成 Phase 1 後的決策點

跑完 `latency_bench.py`，根據結果決定：

| 情境 | 行動 |
|------|------|
| P50 < 2.5s, P95 < 4s | 進 Phase 2，按原計畫包 Tauri |
| P50 2.5-4s | 試 `large-v3-turbo` → `medium`，或考慮 Deepgram |
| P50 > 4s | 重新評估架構，可能要全雲端 |
| 翻譯品質差 | 強化 prompt、加術語表、考慮升級到 Sonnet |
