import { Suspense } from "react";
import { ChatScreen } from "@/components/chat/chat-screen";

function ChatFallback() {
  return (
    <div className="px-4 py-8 text-sm text-muted-foreground" aria-busy="true">
      正在打开对话…
    </div>
  );
}

export default function ChatPage() {
  return (
    <Suspense fallback={<ChatFallback />}>
      <ChatScreen />
    </Suspense>
  );
}
