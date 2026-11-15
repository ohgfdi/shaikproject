import { BooksWorkspace } from "@/components/books/books-workspace";
import { PageHeader } from "@/components/layout/page-header";
import { requirePageAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";

export const metadata = { title: "Books" };

/**
 * The CA books workspace: one confidential set of books per client, the
 * Schedule III chart seeded on creation, and the four statements derived from
 * the stored journal. Per-client isolation is enforced by the books server
 * layer (a book id is never trusted without its workspace).
 */
export default async function BooksPage() {
  const ctx = await requirePageAuth();
  const books = await prisma.book.findMany({
    where: { workspaceId: ctx.workspace.id },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      name: true,
      legalName: true,
      gstin: true,
      pan: true,
      entityType: true,
      booksFrom: true,
      fiscalYearEnd: true,
    },
    take: 200,
  });

  return (
    <div>
      <PageHeader
        title="Books"
        description="Double-entry books of accounts per client — chart of accounts, vouchers and the statements a CA signs: trial balance, P&L, balance sheet and cash flow, all derived from one balanced journal."
      />
      <div className="mt-6">
        <BooksWorkspace initialBooks={books} />
      </div>
    </div>
  );
}
