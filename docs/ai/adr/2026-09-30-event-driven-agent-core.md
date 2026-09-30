# One event-driven agent core replaces the chat orchestrator

Status: Proposed

## Context

The chat orchestrator in `@proj-airi/core-agent` answers one request at a time. A caller sends a
message, the runtime runs the tool rounds, and it returns. Nothing wakes the character on its own.
Other sources, such as a game or a livestream, can reach it only through `spark:notify` and
`spark:command`. Each source then needs its own sub-agent behind it. Two agents that play one
character split its decisions and its context.

An experiment in `proj-airi/airicraft` (`experiments/cortico-world`) mounted the stage and a game as
Worlds on one Cortico agent. It showed that one agent with an event queue works:

- Chat, job results and speech end wake one agent. A quiet heartbeat keeps it present.
- A trigger mode chosen by the event producer controls how an event wakes the agent.
- A soak run showed the costs. A tool receipt of 100 000 characters filled the prompt. The default
  "silence is normal" prompt made heartbeat wakes go quiet. Waking on every speech end doubled the
  request rate.

## Decision

- `@proj-airi/core-agent` gets one `AgentLoop`. It owns one conversation and one consumer.
  Every source pushes events into a `WakeBus`. The loop takes a batch, runs one turn, and waits.
- A plugin supplies tools, events, or both. Tools use the existing plugin tool registry. Events use
  a new events kit. A plugin does not call the model and does not read the conversation.
- Each event has a trigger mode. The producer chooses it.

  | Mode | Effect |
  | --- | --- |
  | `preempt` | Delivers now and cancels a model call that has not produced output. |
  | `flush` | Delivers now with the queued events. |
  | `debounce` | Joins a batch. The batch delivers after a quiet gap, an age limit, or a size limit. |
  | `piggyback` | Waits in the queue. It rides with the next batch and never wakes the agent. |

  Chat events default to `flush`. Other external events default to `debounce`. Internal events default
  to `flush`.
- A heartbeat pushes a quiet notice after a base interval. The interval doubles for each quiet beat
  up to eight times the base. Any external event resets it.
- Streamed assistant text stays the speech. It goes to the existing token and marker hooks, so
  streaming speech and Live2D markers work as before. An empty reply is silence.
- Speech end is an event with `piggyback` by default. A setting can make it `debounce` or `flush`.
- A tool receipt is cut to a limit and says how much it left out.
- The loop has a spend guard. It stops waking on `debounce` and `heartbeat` when a token budget for a
  time window is used up. Chat still wakes the agent.
- The new loop replaces `createChatOrchestratorRuntime`. The first version drops queued sends, chat
  hooks other than the token and marker hooks, Spark notify, and vision input.

## Consequences

- One agent decides what to say and what to do. A game plugin supplies tools and events. It has no
  second model behind it.
- The chat store keeps the session store and the streaming message shape. The UI does not change.
- Plugins that used `spark:notify` need a port to the events kit. That is follow-up work.
- Heartbeat and speech-end wakes cost tokens. Defaults are conservative and the spend guard bounds
  them.

## Not in scope

- Context handoff with a summary. The first version drops the oldest whole turns when the estimate
  passes a limit.
- Realtime audio transport.
- Cloud sync of the new event turns.
