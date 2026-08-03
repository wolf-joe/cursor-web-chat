import os

from cursor_sdk import Agent, LocalAgentOptions


def main():
    with Agent.create(
        model="composer-2.5",
        local=LocalAgentOptions(cwd='/path/to/your-project'),
    ) as agent:
        print("Cursor 对话已启动（输入空行 / Ctrl+C / Ctrl+D 退出）")
        while True:
            try:
                user_input = input("\nyou> ")
            except (EOFError, KeyboardInterrupt):
                print()
                break
            if not user_input.strip():
                break

            run = agent.send(user_input)
            print("ai> ", end="", flush=True)
            for chunk in run.iter_text():
                print(chunk, end="", flush=True)
            print()


if __name__ == "__main__":
    main()
