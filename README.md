# pi-ask-question

This extension lets [Pi](https://github.com/earendil-works/pi) ask you a question and wait for your answer before it carries on. Turn on `/grill-me` when you want to work through a vague request together before the agent starts.

![Pi calls ask_question, you choose or type an answer in the question UI, and the agent continues with your answer. A separate five-minute timeout returns an AFK reply.](.github/readme/question-flow.png)

*Answer in Pi, then let the agent carry on. If you haven't finished after five minutes, it receives an AFK reply.*

## Install and try it

Requires Pi 1.0.0+ and Node.js 24+. Works with official Pi releases and Mitch's Pi fork.

```bash
pi install npm:@fitchmultz/pi-ask-question
pi
```

Already running Pi? Use `/reload` to load the extension. Then try a request like:

> Help me plan a settings page. Use ask_question to ask which settings to include before you start.

You can also [install from GitHub](docs/reference.md#installation-and-updates).

## Answering questions

Pick a choice or select **Type a custom answer** to write your own. For multi-select questions, you can choose more than one answer.

In the terminal, use Up/Down to move and Enter to answer. Space toggles multi-select choices. For a question set or multi-select, check the final review and press Enter to submit. Escape cancels; if you're editing a custom answer, it takes you back to the choices instead. Your editor draft stays intact while you're answering.

The UI shows your configured bindings. See the [terminal controls](docs/reference.md#terminal-controls) for switching questions and reading long text.

Each call shares a five-minute timer across all its questions. If it runs out, Pi receives an AFK reply and can use its best judgment. Saved answers are kept. Unfinished typing isn't submitted, and the tool doesn't pick an option for you.

Question dialogs work in Pi's terminal and in RPC clients that handle Pi's selection and input dialogs. The tool returns an error in print and JSON modes.

## Work through a request with `/grill-me`

Turn it on before giving Pi a request you want to think through:

```text
/grill-me on
```

This tells the agent to check the available evidence first, then ask one blocking question at a time with its suggested answer first. Pi can still get on with obvious, low-risk steps.

Use `/grill-me` to toggle, `/grill-me off` to stop, or `/grill-me status` to check. You'll see `grill-mode` in the terminal footer while it's on. Pi remembers the setting for your current session branch, even after `/reload`. In print and JSON modes, grill-me asks in normal text.

## More details

The [tool reference](docs/reference.md#tool-shape) has input examples, result fields, and the finer points of UI behavior. If you're building an extension that answers questions through Pi's event bus, see [cooperative TUI answers](docs/reference.md#cooperative-tui-answers).

The [development guide](docs/development.md) covers local loading, tests, host compatibility, and publishing. See the [changelog](CHANGELOG.md) for recent changes, or [open an issue](https://github.com/fitchmultz/pi-ask-question/issues) if something isn't working.

## License

[MIT](LICENSE), Mitch Fultz.
