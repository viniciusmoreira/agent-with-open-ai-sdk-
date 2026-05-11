import { Chat } from "@/components/chat/chat";
import { UploadPanel } from "@/components/upload-panel/upload-panel";
import { UploadReadyProvider } from "@/components/upload-panel/upload-ready-context";

export default function Home() {
  return (
    <UploadReadyProvider>
      <main className="mx-auto flex h-full w-full max-w-5xl flex-1 flex-col gap-4 p-4 lg:flex-row">
        <aside className="w-full lg:w-80 lg:shrink-0">
          <UploadPanel />
        </aside>
        <section className="flex min-h-0 flex-1 flex-col">
          <Chat />
        </section>
      </main>
    </UploadReadyProvider>
  );
}
