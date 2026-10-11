# pi-ask-question

This [Pi](https://github.com/earendil-works/pi) extension asks for your decisions before the agent continues a task. Use `/grill-me` to guide the agent through unclear requirements.

![Pi calls ask_question, shows choices, and returns your answer to the agent. A separate five-minute timeout returns an AFK reply.](.github/readme/question-flow.png)

## Install

Requires Pi 1.0.0+ and Node.js 24+. Supports official Pi releases and Mitch's Pi fork.

Run these commands:

```bash
pi install npm:@fitchmultz/pi-ask-question
pi
```

Use `/reload` if Pi is already open. See [Git installation](docs/reference.md#installation-and-updates) for the alternative source.

## Try it

Send this request to Pi:

> Plan a settings page. Use ask_question to ask which settings to include first.

Select a choice or select **Type a custom answer**. Multi-select questions let you select more than one choice.

Use Up/Down to move between choices. Press Enter to answer. For multi-select questions, press Space to change selected choices. Submit question sets and multi-select answers from the final review.

Escape leaves the custom answer editor; otherwise, it cancels the question. Your editor draft stays unchanged. See [terminal controls](docs/reference.md#terminal-controls) for question navigation, long text, and custom bindings.

## Limits

Each call has one five-minute limit for all questions. At timeout, the agent receives an AFK reply and can use its best judgment.

The tool keeps saved answers. It does not submit unsaved custom answer text or select an answer for you.

Question dialogs require the terminal UI or an RPC client that supports Pi dialogs. Print and JSON modes return a tool error.

## Check requirements with `/grill-me`

Enable the mode before your request:

```text
/grill-me on
```

The mode guides the agent to check available evidence and ask one blocking question at a time. The agent puts its suggested answer first. The agent can continue with obvious, low-risk steps.

Use `/grill-me` to toggle the mode. Use `/grill-me off` to disable the mode. Use `/grill-me status` to check the mode.

The terminal footer shows `grill-mode` when enabled. Pi saves the setting in your current session branch. The setting survives `/reload`.

In print and JSON modes, the agent asks questions in normal text.

## Reference

[Tool reference](docs/reference.md#tool-shape) covers input examples, result fields, and UI details. [Cooperative TUI answers](docs/reference.md#cooperative-tui-answers) documents the event protocol for trusted extensions.

[Development](docs/development.md) covers local tests, host compatibility, and publication. See the [changelog](CHANGELOG.md) for changes. [Report an issue](https://github.com/fitchmultz/pi-ask-question/issues) if the extension fails.

## License

[MIT](LICENSE), Mitch Fultz.
