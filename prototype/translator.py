import asyncio
import time
from dataclasses import dataclass
from typing import Callable

import anthropic


SYSTEM_PROMPT = """你是專業即時會議口譯員。將使用者輸入的中文翻譯為 {target_lang}。
規則：
1. 只輸出譯文，不要任何解釋、引號、標點修飾
2. 保留專有名詞原文（公司名、產品名、人名）
3. 口語化但專業，符合會議場合
4. 若輸入是不完整片段，仍盡力翻譯，不要回問"""

LANG_MAP = {
    "en": "English",
    "vi": "Vietnamese (Tiếng Việt)",
}


@dataclass
class TranslationMetrics:
    target: str
    first_token_ms: float
    total_ms: float
    text: str


class Translator:
    def __init__(self, model: str = "claude-haiku-4-5"):
        self.client = anthropic.AsyncAnthropic()
        self.model = model

    async def translate_stream(self, text: str, target: str):
        system = [{
            "type": "text",
            "text": SYSTEM_PROMPT.format(target_lang=LANG_MAP[target]),
            "cache_control": {"type": "ephemeral"},
        }]
        async with self.client.messages.stream(
            model=self.model,
            max_tokens=1024,
            system=system,
            messages=[{"role": "user", "content": text}],
        ) as stream:
            async for chunk in stream.text_stream:
                yield chunk

    async def translate_to(
        self,
        text: str,
        target: str,
        on_chunk: Callable[[str, str], None] | None = None,
    ) -> TranslationMetrics:
        t0 = time.perf_counter()
        first_token_ms: float | None = None
        pieces: list[str] = []
        async for chunk in self.translate_stream(text, target):
            if first_token_ms is None:
                first_token_ms = (time.perf_counter() - t0) * 1000
            pieces.append(chunk)
            if on_chunk:
                on_chunk(target, chunk)
        return TranslationMetrics(
            target=target,
            first_token_ms=first_token_ms or 0.0,
            total_ms=(time.perf_counter() - t0) * 1000,
            text="".join(pieces),
        )

    async def translate_both(
        self,
        text: str,
        on_chunk: Callable[[str, str], None] | None = None,
    ) -> dict[str, TranslationMetrics]:
        en, vi = await asyncio.gather(
            self.translate_to(text, "en", on_chunk),
            self.translate_to(text, "vi", on_chunk),
        )
        return {"en": en, "vi": vi}
