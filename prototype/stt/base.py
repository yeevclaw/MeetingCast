from dataclasses import dataclass


@dataclass
class Transcript:
    text: str
    is_final: bool
    t_start: float = 0.0
    t_end: float = 0.0
    # Segment boundary kind for finals: "clause" / "forced" keep the
    # downstream translation group open, "sentence" / "pause" close it.
    # None (older backends / interims) is treated as "sentence" by Rust.
    boundary: str | None = None
