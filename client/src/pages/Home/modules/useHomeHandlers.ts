import { Message } from '@/shared/schema';

interface UseHomeHandlersProps {
  sessionId: string | null;
  messages: Message[];
  setMessages: (messages: Message[] | ((prev: Message[]) => Message[])) => void;
  uploadMutation: {
    mutate: (payload: { file: File; fileSize: number; sheetName?: string }) => void;
  };
  chatMutation: {
    mutate: (payload: { message: string; targetTimestamp?: number }) => void;
  };
  resetState: () => void;
}

export const useHomeHandlers = ({
  sessionId,
  messages,
  setMessages,
  uploadMutation,
  chatMutation,
  resetState,
}: UseHomeHandlersProps) => {
  const handleFileSelect = (file: File, opts?: { sheetName?: string }) => {
    uploadMutation.mutate({ file, fileSize: file.size, sheetName: opts?.sheetName });
  };

  const handleSendMessage = (message: string) => {
    if (!sessionId) return;
    
    const userMessage: Message = {
      role: 'user',
      content: message,
      timestamp: Date.now(),
    };
    
    setMessages((prev) => [...prev, userMessage]);
    chatMutation.mutate({ message, targetTimestamp: userMessage.timestamp });
  };

  const handleUploadNew = () => {
    resetState();
  };

  const handleEditMessage = (messageIndex: number, newContent: string) => {
    if (!sessionId) return;
    
    setMessages((prev) => {
      const updated = [...prev];
      
      // Update the user message
      if (updated[messageIndex] && updated[messageIndex].role === 'user') {
        updated[messageIndex] = {
          ...updated[messageIndex],
          content: newContent,
        };
        
        // Remove ALL messages below the edited message (not just the immediate assistant response)
        // This includes all subsequent user and assistant messages
        if (updated.length > messageIndex + 1) {
          updated.splice(messageIndex + 1);
        }
      }
      
      // P-047: capture the target timestamp synchronously and hand it to
      // the mutation directly — no setTimeout race where the state update
      // could land in a different order than the mutation call.
      const targetTimestamp = updated[messageIndex]?.timestamp;
      chatMutation.mutate({ message: newContent, targetTimestamp });

      return updated;
    });
  };

  return {
    handleFileSelect,
    handleSendMessage,
    handleUploadNew,
    handleEditMessage,
  };
};
