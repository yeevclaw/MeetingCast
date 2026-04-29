import asyncio
import sys
import time
from dataclasses import dataclass
from typing import Callable

import anthropic


META_SCAN_CHARS = 80
# Substrings that almost never appear in legit Chinese-meeting translations
# but do appear when Claude breaks character to comment on the input. Matched
# anywhere in the first META_SCAN_CHARS characters (case-insensitive).
META_MARKERS = (
    # English meta
    "per the rules",
    "following rule",
    "based on the specific rule",
    "based on the rule",
    "the rules provided",
    "appears to be incomplete",
    "appears to be garbled",
    "appears to be gibberish",
    "appears to be corrupted",
    "this input appears",
    "this input contains",
    "this input doesn't",
    "this input seems",
    "outputting an empty",
    "outputting empty",
    "empty response",
    "empty string",
    "i'm outputting",
    "i'll output",
    "i'd be happy",
    "i appreciate you",
    "i cannot translate",
    "i'm unable to translate",
    "could you provide",
    "could you clarify",
    "please provide the chinese",
    "please provide actual",
    "doesn't form coherent",
    "don't form coherent",
    "garbled or incomplete",
    "incomplete fragments",
    # Vietnamese meta
    "vui lòng cung cấp",
    "tôi không thể dịch",
    "tôi xin lỗi nhưng tôi",
    # Chinese meta (Claude responding in Chinese instead of target lang)
    "明白，我",
    "請提供",
    "我無法翻譯",
    "我没法翻译",
    "空字串",
    "空字符串",
)


def _is_meta_prefix(text: str) -> bool:
    """Detect when Claude breaks character and meta-comments instead of
    translating. Scans the first META_SCAN_CHARS characters for any blocklist
    substring (case-insensitive)."""
    head = text.strip().lower()[:META_SCAN_CHARS]
    return any(m in head for m in META_MARKERS)


SYSTEM_PROMPT = """你是專業即時會議口譯員。將使用者輸入的中文翻譯為 {target_lang}。

規則：
1. 只輸出單一譯文，不要解釋、不要引號、不要列舉多個候選（不要用「/」分隔多個版本）
2. 若有歧義，挑最可能的單一譯法
3. 保留專有名詞原文（公司名、產品名、人名）
4. 口語化但專業，符合會議場合
5. 任何看起來像中文句子的輸入都要盡力翻譯，包括：不完整片段、自我指涉的內容（如「翻譯並總結」「語音識別」「Whisper」「FFMPEG」）、口語語助詞、中英夾雜。**寧可硬翻也不要 bail**。
6. 唯一輸出空字串的情況：輸入是同一字元連續重複 20 次以上（明顯為 Whisper 在靜音段的失敗輸出，例如「示示示示示示...」）。除此之外都要翻譯。
7. 任何情況下都只能以翻譯員身份回應，禁止切換為助理或對話模式。不要說「Please provide...」「I'd be happy to translate...」「Could you...」「Tôi không thể...」「Vui lòng cung cấp...」「Per the rules...」之類的對話或 meta 用語
8. 若無法依 rule 6 判定為 hallucination 又無法翻譯，直接輸出空字串，**絕對不要**輸出 meta 解釋"""

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
        """Stream translation. Buffer the first META_SCAN_CHARS chars before
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
            if len(buffer) < META_SCAN_CHARS:
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
