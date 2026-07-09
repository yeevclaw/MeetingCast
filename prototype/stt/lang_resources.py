"""Per-language Whisper hallucination blocklists.

Whisper leaks training-data phrases when fed silence or noise — audiobook /
YouTube outros, subscribe asks, subtitle credits, music / silence markers.
The set of leaks is language-dependent: a zh-pinned decode emits 謝謝觀看 /
amara.org, a ja decode emits ご視聴ありがとうございました, and so on. English
outros leak under *every* language pin, so they are always included.

Matching is case-insensitive substring (see stt.local._is_known_hallucination),
so ASCII entries are stored lowercase; CJK / kana have no case, and Vietnamese
diacritics lower-case cleanly.

`hallucination_blocklist(language)` = COMMON + EN (always) + per-language.
The zh result is item-identical to the historical KNOWN_HALLUCINATIONS tuple
plus the newly-added "amara.org".
"""

# Language-neutral leaks: music / silence markers Whisper emits on non-speech
# regardless of the pinned decoding language.
HALLUCINATIONS_COMMON = ("♪", "(music)", "[music]", "[silence]")

# English audiobook / scripture / YouTube outros. Included in every language's
# blocklist because Whisper leaks these English phrases under any language pin.
HALLUCINATIONS_EN = (
    "exodus",
    "thanks for watching",
    "thank you for watching",
    "please subscribe",
    "subscribe to my channel",
    "like and subscribe",
    "see you in the next video",
    "see you next time",
)

# Chinese training-data leaks (audiobook / video outro) + the classic
# subtitle-credit leak "Subtitles by the Amara.org community".
HALLUCINATIONS_ZH = (
    "感谢观看",
    "謝謝觀看",
    "请订阅",
    "請訂閱",
    "amara.org",
)

# Japanese YouTube outros: "thank you for watching / listening", "subscribe to
# the channel", "see you in the next video", "thank you for watching to the end".
HALLUCINATIONS_JA = (
    "ご視聴ありがとう",
    "ご清聴ありがとう",
    "チャンネル登録",
    "また次の動画で",
    "最後までご覧いただき",
)

# Vietnamese YouTube outros: "subscribe to the channel", "thank you for
# following", "see you again in ...".
HALLUCINATIONS_VI = (
    "đăng ký kênh",
    "cảm ơn các bạn đã theo dõi",
    "hẹn gặp lại các bạn trong",
)

_PER_LANGUAGE = {
    "zh": HALLUCINATIONS_ZH,
    "ja": HALLUCINATIONS_JA,
    "vi": HALLUCINATIONS_VI,
}


def hallucination_blocklist(language: str) -> tuple[str, ...]:
    """Case-insensitive substring markers Whisper hallucinates on silence, for
    the given decoding language. COMMON + EN (English outros leak under any
    language pin) + the per-language set. Unknown languages get COMMON + EN."""
    return HALLUCINATIONS_COMMON + HALLUCINATIONS_EN + _PER_LANGUAGE.get(language, ())
