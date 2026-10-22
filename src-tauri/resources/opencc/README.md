# OpenCC 字典來源

`STCharacters.txt` 原樣取自本專案已鎖定的 `ferrous-opencc 0.4.0` 套件
`assets/dictionaries/STCharacters.txt`（上游 OpenCC，Apache-2.0；授權見 `LICENSE`）。
此檔僅用於辨認「候選繁體包含原字」的共用字，不自行維護轉換對照表。
更新 ferrous-opencc 時應同步檢查此字典與保留字回歸測試。

採保守策略：共用字一律保留，含簡體的相鄰詞句也不改姓氏、品牌或合法字形；
例如「现在台灣的软件」→「現在台灣的軟件」，「后台」保留原字。
其餘字形仍依 s2tw 的詞組上下文轉換，不改「軟件」等用語。
