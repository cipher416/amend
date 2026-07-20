import { createFileRoute } from "@tanstack/react-router"

import { WikiWorkflow } from "@/components/wiki-workflow"

export const Route = createFileRoute("/")({ component: WikiWorkflow })
