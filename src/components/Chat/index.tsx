import { createResizeObserver } from "@solid-primitives/resize-observer"
import { createSignal, onMount } from "solid-js"
import { useSearchParams } from "solid-start"
import { defaultEnv } from "~/env"
import { setStore, store } from "~/store"
import type { ChatMessage } from "~/types"
import { isMobile } from "~/utils"
import MessageBox, { defaultMessage } from "./MessageBox"
import InputBox from "./InputBox"
import PrefixTitle from "../PrefixTitle"

let _setting = defaultEnv.CLIENT_DEFAULT_SETTING
if (import.meta.env.CLIENT_DEFAULT_SETTING) {
  try {
    _setting = {
      ..._setting,
      ...JSON.parse(import.meta.env.CLIENT_DEFAULT_SETTING)
    }
  } catch (e) {
    console.error("Error parsing DEFAULT_SETTING:", e)
  }
}

const _ = import.meta.env.CLIENT_AUTO_RESET_CONTINUOUS_DIALOGUE
const __ = defaultEnv.CLIENT_AUTO_RESET_CONTINUOUS_DIALOGUE
const _reset = _ && _ !== String(__) ? !__ : __

export default function (props: { sessionID?: string }) {
  let containerRef: HTMLDivElement
  let controller: AbortController | undefined = undefined
  const [containerWidth, setContainerWidth] = createSignal("init")
  const [searchParams, setSearchParams] = useSearchParams()

  onMount(() => {
    createResizeObserver(containerRef, ({ width }, el) => {
      if (el === containerRef) setContainerWidth(`${width}px`)
    })
    setTimeout(() => {
      document.querySelector("#root")?.classList.remove("before")
    })
    document.querySelector("#root")?.classList.add("after")
    const setting = localStorage.getItem("setting")
    const session = localStorage.getItem("session")
    const allSession = localStorage.getItem("all-session")
    try {
      let archiveSession = false
      if (setting) {
        const parsed = JSON.parse(setting)
        archiveSession = parsed.archiveSession
        setStore("setting", t => ({
          ...t,
          ...parsed,
          ...(_reset ? { continuousDialogue: false } : {})
        }))
      }
      if (searchParams.q) {
        sendMessage(searchParams.q)
      } else {
        if (session && archiveSession) {
          const parsed = JSON.parse(session) as ChatMessage[]
          if (parsed.length === 1 && parsed[0].type === "default") {
            setStore("messageList", [defaultMessage])
          } else setStore("messageList", parsed)
        } else setStore("messageList", [defaultMessage])
      }
    } catch {
      console.log("Setting parse error")
    }
  })

  function archiveCurrentMessage() {
    if (store.currentAssistantMessage) {
      setStore("messageList", k => [
        ...k,
        {
          role: "assistant",
          content: store.currentAssistantMessage.trim()
        }
      ])
      setStore("currentAssistantMessage", "")
      setStore("loading", false)
      controller = undefined
    }
    !isMobile() && store.inputRef?.focus()
    searchParams.q && setSearchParams({ q: undefined })
  }

  function stopStreamFetch() {
    if (controller) {
      controller?.abort()
      archiveCurrentMessage()
    }
  }

  async function sendMessage(value?: string) {
    const inputValue = value ?? store.inputContent
    if (!inputValue) return
    // @ts-ignore
    if (window?.umami) umami.trackEvent("chat_generate")
    setStore("inputContent", "")
    if (
      !value ||
      value !== store.messageList.filter(k => k.role === "user").at(-1)?.content
    ) {
      setStore("messageList", k => {
        if (k.length === 1 && k[0].type === "default")
          return [
            {
              role: "user",
              content: inputValue
            }
          ]
        return [
          ...k,
          {
            role: "user",
            content: inputValue
          }
        ]
      })
    }

    const systemRule = store.setting.systemRule.trim()
    const message: ChatMessage = {
      role: "user",
      content: inputValue
    }
    if (systemRule) message.content += "。\n\n" + systemRule
    const messages = store.setting.continuousDialogue
      ? [...store.messageList.slice(0, -1), message].filter(
          k => k.role !== "error"
        )
      : [...store.messageList.filter(k => k.type === "locked"), message]

    try {
      setStore("loading", true)
      controller = new AbortController()
      await fetchGPT(messages)
    } catch (error: any) {
      setStore("loading", false)
      controller = undefined
      if (!error.message.includes("abort")) {
        setStore("messageList", k => [
          ...k,
          {
            role: "error",
            content: error.message.replace(/(sk-\w{5})\w+/g, "$1")
          }
        ])
      }
    }
    archiveCurrentMessage()
  }

  async function fetchGPT(messages: ChatMessage[]) {
    const response = await fetch("/api", {
      method: "POST",
      body: JSON.stringify({
        messages,
        key: store.setting.openaiAPIKey || undefined,
        temperature: store.setting.openaiAPITemperature / 100,
        password: store.setting.password,
        model: store.setting.model
      }),
      signal: controller?.signal
    })
    if (!response.ok) {
      const res = await response.json()
      throw new Error(res.error.message)
    }
    const data = response.body
    if (!data) {
      throw new Error("没有返回数据")
    }
    const reader = data.getReader()
    const decoder = new TextDecoder("utf-8")
    let done = false

    while (!done) {
      const { value, done: readerDone } = await reader.read()
      if (value) {
        const char = decoder.decode(value)
        if (char === "\n" && store.currentAssistantMessage.endsWith("\n")) {
          continue
        }
        if (char) {
          setStore("currentAssistantMessage", k => k + char)
        }
      }
      done = readerDone
    }
  }

  return (
    <main ref={containerRef!} class="mt-4">
      {searchParams.q && <PrefixTitle>{searchParams.q}</PrefixTitle>}
      <MessageBox sendMessage={sendMessage} />
      <InputBox
        width={containerWidth()}
        sendMessage={sendMessage}
        stopStreamFetch={stopStreamFetch}
      />
    </main>
  )
}