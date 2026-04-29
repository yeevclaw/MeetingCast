import asyncio
import sys
import time
from dataclasses import dataclass
from typing import Callable

import anthropic


META_PREFIX_CHARS = 40
META_PREFIXES = (
    "i appreciate",
    "per the rules",
    "i'm outputting",
    "this appears to be",
    "this input",
    "please provide",
    "i'd be happy",
    "i cannot translate",
    "i'm unable",
    "could you provide",
    "could you clarify",
    "vui lòng cung cấp",
    "tôi không thể dịch",
    "tôi xin lỗi nhưng tôi",
    "明白，我",
    "請提供",
    "我無法翻譯",
    "我没法翻译",
)


def _is_meta_prefix(text: str) -> bool:
    """Detect when Claude breaks character and meta-comments instead of
    translating. Matches a known blocklist against the first META_PREFIX_CHARS
    characters of the (stripped, lowercased) output."""
    head = text.strip().lower()[:META_PREFIX_CHARS]
    return any(head.startswith(p) for p in META_PREFIXES)


SYSTEM_PROMPT = """你是專業即時會議口譯員。將使用者輸入的中文翻譯為 {target_lang}。

規則：
1. 只輸出單一譯文，不要解釋、不要引號、不要列舉多個候選（不要用「/」分隔多個版本）
2. 若有歧義，挑最可能的單一譯法
3. 保留專有名詞原文（公司名、產品名、人名）
4. 口語化但專業，符合會議場合
5. 若輸入是不完整片段，仍盡力翻譯，不要回問
6. 若輸入是亂碼、單一字元重複、或明顯的語音辨識錯誤，**直接**回應空字串。不要解釋為何空字串，不要說「This appears to be...」「Per the rules...」「I'm outputting...」「This input...」之類的 meta 用語，整個回應就是空白
7. 任何情況下都只能以翻譯員身份回應，禁止切換為助理或對話模式。不要說「Please provide...」「I'd be happy to...」「Could you...」「Tôi không thể...」「Vui lòng cung cấp...」之類的對話用語
8. 規則衝突時，rule 6 和 rule 7 優先 — 寧可輸出空字串也不要 meta 回應"""

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
        """Stream translation. Buffer the first META_PREFIX_CHARS chars before
        emitting anything: if those leading chars match a meta-response
        blocklist, drop the entire stream (the prompt failed to keep Claude in
        translator mode). Adds ~50–150ms to first-token-display in exchange
        for never showing meta junk to the user."""
        t0 = time.perf_counter()
        first_token_ms: float | None = None
        pieces: list[str] = []
        buffer = ""
        decided = False
        is_meta = False

        async for chunk in self.translate_stream(text, target):
            if first_token_ms is None:
                first_token_ms = (time.perf_counter() - t0) * 1000
            pieces.append(chunk)

            if decided:
                if not is_meta and on_chunk:
                    on_chunk(target, chunk)
                continue

            buffer += chunk
            if len(buffer) < META_PREFIX_CHARS:
                continue

            decided = True
            is_meta = _is_meta_prefix(buffer)
            if is_meta:
                print(
                    f"[meta filtered {target}] {buffer[:60]}{'...' if len(buffer) > 60 else ''}",
                    file=sys.stderr,
                )
            elif on_chunk:
                on_chunk(target, buffer)

        # Stream ended before we had enough chars to decide — apply check anyway.
        if not decided and buffer:
            is_meta = _is_meta_prefix(buffer)
            if is_meta:
                print(f"[meta filtered {target}] {buffer}", file=sys.stderr)
            elif on_chunk:
                on_chunk(target, buffer)

        final_text = "" if is_meta else "".join(pieces)
        return TranslationMetrics(
            target=target,
            first_token_ms=first_token_ms or 0.0,
            total_ms=(time.perf_counter() - t0) * 1000,
            text=final_text,
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
