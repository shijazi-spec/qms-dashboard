import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Plus, Search, ClipboardCheck } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Audit } from "@shared/schema";
import { insertAuditSchema } from "@shared/schema";
import { format } from "date-fns";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";

const formSchema = insertAuditSchema.extend({
  title: z.string().min(1, "Title is required"),
  auditNumber: z.string().min(1, "Audit number is required"),
  type: z.string().min(1, "Type is required"),
  auditor: z.string().min(1, "Auditor is required"),
  department: z.string().min(1, "Department is required"),
  scheduledDate: z.string().min(1, "Scheduled date is required"),
});

const statusColors: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  planned: "outline",
  "in-progress": "secondary",
  completed: "default",
  cancelled: "destructive",
};

export default function Audits() {
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const { toast } = useToast();

  const { data: audits, isLoading } = useQuery<Audit[]>({
    queryKey: ["/api/audits"],
  });

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      title: "",
      auditNumber: "",
      type: "",
      status: "planned",
      auditor: "",
      department: "",
      scheduledDate: "",
      findings: 0,
      description: "",
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: z.infer<typeof formSchema>) => {
      return apiRequest("POST", "/api/audits", {
        ...data,
        scheduledDate: new Date(data.scheduledDate).toISOString(),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/audits"] });
      setDialogOpen(false);
      form.reset();
      toast({ title: "Audit created successfully" });
    },
    onError: () => {
      toast({ title: "Failed to create audit", variant: "destructive" });
    },
  });

  const filtered = audits?.filter(
    (a) =>
      a.title.toLowerCase().includes(search.toLowerCase()) ||
      a.auditNumber.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="p-6 space-y-6 overflow-auto h-full">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-audits-title">Audits</h1>
          <p className="text-muted-foreground text-sm">Track internal and external audits</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-add-audit">
              <Plus className="h-4 w-4 mr-2" />
              New Audit
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Create Audit</DialogTitle>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit((data) => createMutation.mutate(data))} className="space-y-4">
                <FormField
                  control={form.control}
                  name="title"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Title</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="Audit title" data-testid="input-audit-title" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="auditNumber"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Audit Number</FormLabel>
                        <FormControl>
                          <Input {...field} placeholder="AUD-001" data-testid="input-audit-number" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="type"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Type</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value}>
                          <FormControl>
                            <SelectTrigger data-testid="select-audit-type">
                              <SelectValue placeholder="Select type" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="internal">Internal</SelectItem>
                            <SelectItem value="external">External</SelectItem>
                            <SelectItem value="supplier">Supplier</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="auditor"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Auditor</FormLabel>
                        <FormControl>
                          <Input {...field} placeholder="Auditor name" data-testid="input-audit-auditor" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="department"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Department</FormLabel>
                        <FormControl>
                          <Input {...field} placeholder="Department" data-testid="input-audit-department" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={form.control}
                  name="scheduledDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Scheduled Date</FormLabel>
                      <FormControl>
                        <Input {...field} type="date" data-testid="input-audit-date" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="description"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Description</FormLabel>
                      <FormControl>
                        <Textarea
                          {...field}
                          value={field.value ?? ""}
                          placeholder="Audit scope and objectives"
                          data-testid="input-audit-description"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={createMutation.isPending} data-testid="button-submit-audit">
                    {createMutation.isPending ? "Creating..." : "Create"}
                  </Button>
                </div>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search audits..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
          data-testid="input-search-audits"
        />
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : filtered && filtered.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Audit #</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Auditor</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead>Scheduled</TableHead>
                  <TableHead>Findings</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((audit) => (
                  <TableRow key={audit.id} data-testid={`row-audit-${audit.id}`}>
                    <TableCell className="font-mono text-sm">{audit.auditNumber}</TableCell>
                    <TableCell>{audit.title}</TableCell>
                    <TableCell className="capitalize">{audit.type}</TableCell>
                    <TableCell>
                      <Badge variant={statusColors[audit.status] || "secondary"}>
                        {audit.status}
                      </Badge>
                    </TableCell>
                    <TableCell>{audit.auditor}</TableCell>
                    <TableCell>{audit.department}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {format(new Date(audit.scheduledDate), "MMM d, yyyy")}
                    </TableCell>
                    <TableCell>{audit.findings ?? 0}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="py-12 text-center text-muted-foreground">
              <ClipboardCheck className="mx-auto h-8 w-8 mb-2 opacity-50" />
              <p className="text-sm">No audits found</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
