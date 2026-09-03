# HostingPlatform Agents & Automations

HostingPlatform Agents and Automations allows users to build agentic automations using the new TypeScript library called Mastra. Mastra works via Agent, Tool, and Workflows.  Workflows contain steps (which may call tools or call Agents). Mastra has many different ways of working, to aid our users and to allow for a more positive experiece in the HostingPlatform environment, we have imposed some additional constraints.

NOTE: All HostingPlatform automations are 1.) time-based triggers or 2.) web-hook triggers (e.g. ChatProvider, Telegram). For web-hook triggers, see the src/triggers/ folder for code examples.  This trigger activates the Workflow.


## HostingPlatform Playground UI
Mastra has its own UI called Mastra Playground, however we have our own version that is setup specifically for the HostingPlatform environment.

It is critical to note that the HostingPlatform Playground is a UI that, you, the HostingPlatform Agent cannot interact with, **only** the user is capable of interacting with it.  One piece of the user interface is an Agent chat view, which allows the user to interact with the **single** agent that has been defined in the project.  There **must** only be a single agent defined for the project, or else it will not work.  Another constraint is that the Agent chat view calls the `.streamLegacy()` and `.generateLegacy()` methods on the Mastra Agent.  This means you **must** setup the AI SDK v4 (the ones compatible with the legacy Mastra stream and generate methods).  This has been delineated in the exampleAgent and exampleWorkflow typescript files.

The other view in the HostingPlatform Playground is the Workflow graph.  This pane allows the user to inspect the Mastra Workflow nodes with plain English.  It is critical, for this reason, that all nodes, tool, and agent `.description` fields are filled out in simple, plain English, since this is what will be shown to the user.  As you change the Workflow (add, remove, change nodes), the user will be able to see your work at a high-level.

## Inngest for Agent Durability

We want users to have durable execution of the Mastra workflows.  So if a workflow fails in production, we can seemlessly pick up where we left off.  For this reason, we have a customization over the default Mastra deployment.  We use a service called inngest which directly works with Mastra.

The key area where this feature is added is in `src/mastra/index.ts`:
```
import { inngest, inngestServe } from "./inngest";
```
and we keep custom code in the `src/mastra/inngest/` folder for handling the inngest durability layer over the Mastra server when we deploy/publish the automation on HostingPlatform's infrastructure.

It is critical to ensure that inngest is hooked up correctly, please make sure to preserve these properties in the root `src/mastra/index.ts`.