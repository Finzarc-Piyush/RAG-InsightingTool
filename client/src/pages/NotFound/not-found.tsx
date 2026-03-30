import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Compass } from "lucide-react";
import { Link } from "wouter";

export default function NotFound() {
  return (
    <div className="flex min-h-[calc(100vh-4.25rem)] w-full items-center justify-center bg-gradient-to-b from-muted/30 to-background p-6">
      <Card className="w-full max-w-md border-border/80 shadow-md">
        <CardHeader className="space-y-3 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-muted">
            <Compass className="h-7 w-7 text-muted-foreground" aria-hidden />
          </div>
          <CardTitle className="text-2xl font-semibold tracking-tight">
            Page not found
          </CardTitle>
          <CardDescription className="text-base">
            This URL does not match any workspace in Marico RAGAlytics. You may have followed an old link or mistyped the address.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 pt-2">
          <Button asChild className="w-full rounded-lg" size="lg">
            <Link href="/analysis">Back to chats</Link>
          </Button>
          <Button asChild variant="ghost" className="w-full rounded-lg">
            <Link href="/dashboard">Open dashboard</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
