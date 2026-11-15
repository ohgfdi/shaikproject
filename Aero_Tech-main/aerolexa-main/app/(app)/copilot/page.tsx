import { ChatInterface } from "@/components/chat/chat-interface";
import { requirePageAuth } from "@/lib/auth/guard";

export const metadata = { title: "Copilot" };

export default async function CopilotPage() {
  await requirePageAuth();

  return (
    <div className="h-[calc(100dvh-8.5rem)]">
      <ChatInterface />
    </div>
  );
}
