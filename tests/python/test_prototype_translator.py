"""Offline coverage for the development-only CLI translator."""
import asyncio
import importlib.util
import json
from pathlib import Path
import re
import sys
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest


REPO = Path(__file__).resolve().parents[2]


@pytest.fixture
def translator_module():
    # Import in isolation: no SDK installation, credentials or native STT deps.
    name = "_test_prototype_translator"
    spec = importlib.util.spec_from_file_location(name, REPO / "prototype/translator.py")
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {
        "anthropic": SimpleNamespace(AsyncAnthropic=Mock()),
        name: module,
    }):
        spec.loader.exec_module(module)
        yield module


class FakeStream:
    def __init__(self, chunks):
        self.chunks = chunks

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    @property
    def text_stream(self):
        async def generate():
            for chunk in self.chunks:
                yield chunk
        return generate()


def make_translator(module, chunks):
    translator = module.Translator()
    stream = Mock(return_value=FakeStream(chunks))
    translator.client = SimpleNamespace(messages=SimpleNamespace(stream=stream))
    return translator, stream


def test_registry_targets_and_prompt_names(translator_module):
    registry = json.loads((REPO / "shared/languages.json").read_text())
    expected = {entry["code"]: entry["prompt_name"] for entry in registry}
    assert translator_module.LANG_MAP == expected
    for target, prompt_name in expected.items():
        translator, stream = make_translator(translator_module, ["translation"])
        result = asyncio.run(translator.translate_to("會議開始", target))
        assert result.text == "translation"
        assert prompt_name in stream.call_args.kwargs["system"][0]["text"]


@pytest.mark.parametrize("method", ["translate_stream", "translate_to"])
def test_unsupported_target_before_api_call(translator_module, method):
    translator, stream = make_translator(translator_module, [])

    async def run():
        if method == "translate_stream":
            return [chunk async for chunk in translator.translate_stream("你好", "xx")]
        return await translator.translate_to("你好", "xx")

    with pytest.raises(ValueError, match="Unsupported target language 'xx'; supported targets:"):
        asyncio.run(run())
    stream.assert_not_called()


def test_markers_match_rust(translator_module):
    rust = (REPO / "src-tauri/src/translator.rs").read_text()
    block = rust.split("const META_MARKERS: &[&str] = &[", 1)[1].split("];", 1)[0]
    assert set(translator_module.META_MARKERS) == set(re.findall(r'^\s*"(.*)",$', block, re.M))


@pytest.mark.parametrize("target,text", [
    ("ja", "翻訳することができません。"),
    ("km", "ខ្ញុំមិនអាចបកប្រែ"),
    ("ja", "入力が不完全" + "。" * 40),
    ("km", "សូមផ្តល់អត្ថបទ" + "។" * 40),
])
def test_meta_filtered_before_callback(translator_module, target, text):
    translator, _ = make_translator(translator_module, list(text))
    callback = Mock()
    result = asyncio.run(translator.translate_to("你好", target, callback))
    assert result.text == ""
    callback.assert_not_called()


def test_legitimate_japanese_apology_is_preserved(translator_module):
    text = "申し訳ありません、会議を始めましょう。"
    translator, _ = make_translator(translator_module, list(text))
    callback = Mock()
    result = asyncio.run(translator.translate_to("抱歉，我們開始會議吧。", "ja", callback))
    assert result.text == text
    assert "".join(call.args[1] for call in callback.call_args_list) == text
