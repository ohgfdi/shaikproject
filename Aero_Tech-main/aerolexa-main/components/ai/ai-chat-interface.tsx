/**
 * Phase 19: AI Chat Interface
 *
 * Conversational analytics interface that allows users to ask
 * natural language questions about their data and get chart
 * recommendations and insights.
 */
import React, { useState, useEffect } from "react";


export type AIMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
  /** Optional: chart configuration if AI recommends a chart */
  chartConfig?: {
    type: "choropleth" | "bar" | "line" | "kpi" | "table";
    title: string;
    description: string;
    fields?: string[];
  };
};

export type AIConversation = {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  messages: AIMessage[];
};

export const AIChatInterface: React.FC = () => {
  const [messages, setMessages] = useState<AIMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [conversationId, setConversationId] = useState("");

  // Load or create conversation
  useEffect(() => {
    // In production, load existing conversation from state
    if (messages.length === 0) {
      setMessages([
        {
          id: "1",
          role: "assistant",
          content:
            "Hello! I'm Ledgerly AI. Ask me anything about your data - 'Show me sales by region' or 'What are my top performing products?'",
          createdAt: new Date(),
        },
      ]);
    }
  }, [messages.length]);

  const sendMessage = async (content: string) => {
    if (!content.trim() || isLoading) return;

    // Add user message
    const userMessage: AIMessage = {
      id: String(Date.now()),
      role: "user",
      content,
      createdAt: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);

    try {
      // Analyze the message and get response
      const response = await analyzeUserQuery(content);
      setMessages((prev) => [...prev, response]);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          id: String(Date.now()),
          role: "assistant",
          content:
            "I'm sorry, I encountered an error. Please try again.",
          createdAt: new Date(),
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const analyzeUserQuery = async (query: string): Promise<AIMessage> => {
    const lowerQuery = query.toLowerCase();

    // Pattern matching for common analytics queries
    if (
      lowerQuery.includes("sales") ||
      lowerQuery.includes("revenue") ||
      lowerQuery.includes("revenue")
    ) {
      return {
        id: String(Date.now()),
        role: "assistant",
        createdAt: new Date(),
        content:
          "I can help you analyze sales data! Would you like me to create a chart showing sales by region, product, or time period? Just let me know what fields you'd like to analyze.",
        chartConfig: {
          type: "bar",
          title: "Sales Analysis",
          description: "Sales performance across dimensions",
          fields: ["revenue", "region", "product"],
        },
      };
    }

    if (lowerQuery.includes("chart") || lowerQuery.includes("graph")) {
      return {
        id: String(Date.now()),
        role: "assistant",
        createdAt: new Date(),
        content:
          "I'd be happy to help you create a chart! What type of chart are you looking for, and what data fields do you want to visualize?",
      };
    }

    if (lowerQuery.includes("top") || lowerQuery.includes("highest")) {
      return {
        id: String(Date.now()),
        role: "assistant",
        createdAt: new Date(),
        content:
          "I can help identify your top performers! What metric would you like to analyze (sales, profit, customers, etc.) and by what dimension (product, region, time period)?",
      };
    }

    if (lowerQuery.includes("trend") || lowerQuery.includes("over time")) {
      return {
        id: String(Date.now()),
        role: "assistant",
        createdAt: new Date(),
        content:
          "I can analyze trends over time! What data would you like to see trends for, and what time period should I cover?",
      };
    }

    if (lowerQuery.includes("compare") || lowerQuery.includes("versus")) {
      return {
        id: String(Date.now()),
        role: "assistant",
        createdAt: new Date(),
        content:
          "I can help you compare datasets! What two or more metrics or categories would you like to compare, and what time period?",
      };
    }

    // Default AI response for unrecognized queries
    return {
      id: String(Date.now()),
      role: "assistant",
      createdAt: new Date(),
      content:
        "I'm Ledgerly AI. I can help you explore your data with natural language queries. Try asking things like: 'Show me sales by region', 'What are my top products?', or 'Show me trends over time'. What would you like to know?",
    };
  };

  return (
    <div className="ai-chat-interface">
      <div className="chat-header">
        <h3>🤖 Ledgerly AI</h3>
        <small>Conversational analytics assistant</small>
      </div>

      <div className="chat-messages">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`chat-message ${msg.role}-message`}
            style={{ animation: "messageIn 0.3s ease" }}
          >
            <div className="message-avatar">
              {msg.role === "user" ? "U" : "AI"}
            </div>
            <div className="message-bubble">
              <p>{msg.content}</p>
              {msg.chartConfig && (
                <div className="chart-suggestion">
                  <strong>💡 AI Suggestion:</strong> {msg.chartConfig.description}
                  <br />
                  <small>{msg.chartConfig.type} chart</small>
                </div>
              )}
            </div>
            <div className="message-time">
              {new Date(msg.createdAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="chat-input-bar">
        <div className="input-wrapper">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={(e) => {
              if (e.key === "Enter" && input.trim()) {
                sendMessage(input);
              }
            }}
            placeholder="Ask Ledgerly AI about your data..."
            className="chat-input"
            disabled={isLoading}
            aria-label="Ask a question about your data"
          />
          <button
            onClick={() => sendMessage(input)}
            disabled={!input.trim() || isLoading}
            className="chat-send-btn"
            aria-label="Send message"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <path
                d="M2.05 5.9a1.995 1.995 0 0 1 .41-1.41l2.19 2.19a1.99 1.99 0 0 1 0 2.82l-2.19 2.19a1.995 1.995 0 0 1-1.41-.41l-2.22-2.22a1.989 1.989 0 0 1 0-2.82l2.22 2.22zM8.1 3.9a1.99 1.99 0 0 1 0 3.9h7.7a1.99 1.99 0 0 1 0 3.9h-7.7a1.99 1.99 0 0 1-1.73-1.41L8.11 3.9a1.99 1.99 0 0 1 0-3.9zm7.42 11.79l-2.22-2.22a.99.99 0 0 0-1.41.09l-1.05 1.05a1.991 1.991 0 0 1-1.4-.7l1.88-1.88a1.989 1.989 0 0 1 1.41 0l1.88 1.88a.99.99 0 0 0 .09 1.41l1.05-1.05a1.991 1.991 0 0 1 1.4.7l1.88-1.88zM22.17 7.2l-2.22 2.22a.99.99 0 0 0 0 1.41l2.22 2.22a.99.99 0 0 0 1.41-.09l2.22-2.22a1.99 1.99 0 0 1-.41-1.41l-2.19-2.19zM12 4.5a7.498 7.498 0 0 0-3.32 1.82l.67 2.33a.54 0 0 1-.52.44l-1.25-1.25a.54 0 0 1-.44-.52l2.07-2.07a.54 0 0 1 .44-.52l1.25 1.25a.54 0 0 1 .52.44l-.66 2.33A7.5 7.5 0 0 0 12 4.5zm0 11.98a3.497 3.497 0 1 1 0-6.996 3.497 3.497 0 0 1 0 6.996z"
              />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
};