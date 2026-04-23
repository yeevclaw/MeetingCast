from dataclasses import dataclass


@dataclass
class Transcript:
    text: str
    is_final: bool
    t_start: float = 0.0
    t_end: float = 0.0
