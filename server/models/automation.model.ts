/**
 * Automation Model
 * CRUD for saved automations (sequences of data ops + dashboard steps)
 */
import {
  Automation,
  AutomationStep,
  createAutomationRequestSchema,
  updateAutomationRequestSchema,
} from "../shared/schema.js";
import { waitForAutomationsContainer } from "./database.config.js";

export type CreateAutomationInput = {
  username: string;
  name: string;
  description?: string;
  steps: AutomationStep[];
};

export type UpdateAutomationInput = {
  name?: string;
  description?: string;
  steps?: AutomationStep[];
};

export async function createAutomation(input: CreateAutomationInput): Promise<Automation> {
  const parsed = createAutomationRequestSchema.parse({
    name: input.name,
    description: input.description,
    steps: input.steps,
  });
  const container = await waitForAutomationsContainer();
  const id = `automation_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const now = Date.now();
  const doc: Automation = {
    id,
    username: input.username,
    name: parsed.name,
    description: parsed.description,
    steps: parsed.steps,
    createdAt: now,
    updatedAt: now,
  };
  const { resource } = await container.items.create(doc);
  return resource as unknown as Automation;
}

export async function getAutomationById(id: string, username: string): Promise<Automation | null> {
  const container = await waitForAutomationsContainer();
  try {
    const { resource } = await container.item(id, username).read();
    return resource as unknown as Automation;
  } catch (err: any) {
    if (err?.code === 404) return null;
    throw err;
  }
}

export async function getAutomationsByUser(username: string): Promise<Automation[]> {
  const container = await waitForAutomationsContainer();
  const { resources } = await container.items
    .query({
      query: "SELECT * FROM c WHERE c.username = @username ORDER BY c.updatedAt DESC",
      parameters: [{ name: "@username", value: username }],
    })
    .fetchAll();
  return resources as unknown as Automation[];
}

export async function updateAutomation(
  id: string,
  username: string,
  input: UpdateAutomationInput
): Promise<Automation | null> {
  const existing = await getAutomationById(id, username);
  if (!existing) return null;
  const parsed = updateAutomationRequestSchema.partial().parse(input);
  const container = await waitForAutomationsContainer();
  const updated: Automation = {
    ...existing,
    ...(parsed.name !== undefined && { name: parsed.name }),
    ...(parsed.description !== undefined && { description: parsed.description }),
    ...(parsed.steps !== undefined && { steps: parsed.steps }),
    updatedAt: Date.now(),
  };
  const { resource } = await container.items.upsert(updated);
  return resource as unknown as Automation;
}

export async function deleteAutomation(id: string, username: string): Promise<boolean> {
  const existing = await getAutomationById(id, username);
  if (!existing) return false;
  const container = await waitForAutomationsContainer();
  await container.item(id, username).delete();
  return true;
}
