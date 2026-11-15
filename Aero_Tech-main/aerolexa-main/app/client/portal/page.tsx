"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/overlays";
import { api } from "@/lib/client/api";
import { cn } from "@/lib/utils";

type Document = {
  id: string;
  title: string;
  uploadedAt: string;
  uploadedBy: string;
};

type Deadline = {
  id: string;
  title: string;
  dueDate: string;
  daysLeft: number;
  state: string;
};

function ClientPortal() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("token");

  const [engagementId, setEngagementId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [deadlines, setDeadlines] = useState<Deadline[]>([]);
  const [docTitle, setDocTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    if (token) {
      fetch(`/api/client/token?token=${token}`)
        .then((res) => res.json())
        .then((data) => {
          if (data.ok) {
            setEngagementId(data.engagementId);
            router.push(`/client/engagements/${data.engagementId}`);
          } else {
            setError(data.error ?? "Invalid or expired access token.");
            toast({
              title: "Access Denied",
              message: data.error ?? "Invalid or expired access token.",
              type: "error",
            });
          }
        })
        .catch((err) => {
          setError("Failed to verify access.");
          toast({
            title: "Error",
            message: "Failed to verify access token.",
            type: "error",
          });
        })
        .finally(() => setLoading(false));
    }
  }, [token]);

  useEffect(() => {
    if (engagementId) {
      fetchEngagementData();
    }
  }, [engagementId]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface/50">
        <p className="text-muted">Verifying access...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 rounded-lg bgdestructive/10 text-destructive text-sm">
        <p>{error}</p>
        <Link href="/login" className="font-medium text-accent hover:underline">Sign in to access your engagements</Link>
      </div>
    );
  }

  if (!engagementId) {
    return (
      <div className="p-6 text-center">
        <h3 className="font-semibold mb-4">Engagement Portal</h3>
        <p className="text-muted">
          Please use your access token to view your engagement.
        </p>
      </div>
    );
  }

  const handleDocumentUpload = async () => {
    if (!docTitle.trim() || !file) {
      toast({
        title: "Validation Error",
        message: "Please enter a title and select a file.",
        type: "error",
      });
      return;
    }

    setUploading(true);
    setUploadError(null);

    try {
      const formData = new FormData();
      formData.append("title", docTitle);
      formData.append("file", file!);

      const result = await api("/api/client/documents", {
        method: "POST",
        body: formData,
      });

      toast({
        title: "Success",
        message: "Document uploaded successfully.",
        type: "success",
      });

      setDocTitle("");
      setFile(null);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Unknown error");
      toast({
        title: "Upload Failed",
        message: err instanceof Error ? err.message : "Unknown error",
        type: "error",
      });
    } finally {
      setUploading(false);
    }
  };

  const fetchEngagementData = async () => {
    setLoading(true);
    try {
      const docs = await api(`/api/client/documents?engagementId=${engagementId}`);
      setDocuments(docs as Document[] || []);

      const dl = await api(`/api/compliance/deadlines?engagementId=${engagementId}`);
      setDeadlines(dl as Deadline[] || []);
    } catch (err) {
      setError("Failed to load engagement data.");
      toast({
        title: "Error",
        message: "Could not load engagement data.",
        type: "error",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-surface/50">
      <nav className="border-b border-line/50">
        <div className="max-w-[1200px] mx-auto px-4 py-3">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
            <Link href="/client" className="font-medium text-accent hover:underline">
              ← Back to Portals
            </Link>
            <span className="text-sm text-muted">
              Engagement {engagementId}
            </span>
          </div>
        </div>
      </nav>

      <main className="max-w-[1200px] mx-auto p-4 pt-6">
        <div className="grid grid-cols-1 gap-4">
          {/* Left column: Documents & Upload */}
          <div className="lg:col-span-2 rounded-lg bgdestructive/5 p-4">
            <h4 className="font-semibold mb-3">
              Document Library ({documents.length})
            </h4>
            {documents.length === 0 && (
              <p className="text-muted text-sm">
                No documents uploaded yet. Upload your first document above.
              </p>
            )}
            <ul className="space-y-2 max-h-80 overflow-y-auto">
              {documents.map((doc) => (
                <li
                  key={doc.id}
                  className="flex items-center justify-between px-2 py-2 rounded border-b border-line/20"
                >
                  <span className="font-medium">{doc.title}</span>
                  <span className="text-xs text-muted">
                    {doc.uploadedAt ? new Date(doc.uploadedAt).toLocaleDateString() : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* Right column: Upload Form */}
          <div className="rounded-lg bgdestructive/5 p-4">
            <h4 className="font-semibold mb-3">Upload Document</h4>
            <p className="text-muted text-sm">
              Add documents to the engagement working paper library.
            </p>
            <form onSubmit={handleDocumentUpload} className="flex flex-col gap-3">
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Document title"
                  value={docTitle}
                  onChange={(e) => setDocTitle(e.target.value)}
                  required
                  className="input input-bordered flex-1"
                />
                <input
                  type="file"
                  accept=".pdf,.doc,.docx,.txt"
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                  className="input input-bordered hidden"
                />
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => {
                    const fileInput = document.getElementById("doc-file") as HTMLInputElement | null;
                    fileInput?.click();
                  }}
                >
                  Browse
                </Button>
              </div>
              <small className="text-caption text-muted">
                Supported: PDF, DOC, DOCX, TXT
              </small>
            </form>
          </div>
        </div>

        {/* Engagement details */}
        <div className="mt-6 rounded-lg bgdestructive/5 p-4">
          <h4 className="font-semibold mb-3">Engagement {engagementId}</h4>
          <p className="text-muted">
            Document library and compliance calendar for this engagement.
          </p>
          <p className="text-muted text-sm mt-2">
            Upload documents, view deadlines, and track progress.
          </p>
        </div>
      </main>
    </div>
  );
}
// Next.js page modules must expose a default export.
export default ClientPortal;
