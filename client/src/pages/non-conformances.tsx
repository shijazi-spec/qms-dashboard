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
import { Plus, Search, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { NonConformance } from "@shared/schema";
import { insertNonConformanceSchema } from "@shared/schema";
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

const formSchema = insertNonConformanceSchema.extend({
  title: z.string().min(1, "Title is required"),
  ncNumber: z.string().min(1, "NC number is required"),
  severity: z.string().min(1, "Severity is required"),
  source: z.string().min(1, "Source is required"),
  department: z.string().min(1, "Department is required"),
  assignedTo: z.string().min(1, "Assigned to is required"),
});

const severityColors: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  critical: "destructive",
  major: "default",
  minor: "secondary",
};

export default function NonConformances() {
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const { toast } = useToast();

  const { data: ncs, isLoading } = useQuery<NonConformance[]>({
    queryKey: ["/api/non-conformances"],
  });

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      title: "",
      ncNumber: "",
      severity: "",
      status: "open",
      source: "",
      department: "",
      assignedTo: "",
      description: "",
      rootCause: "",
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: z.infer<typeof formSchema>) => {
      return apiRequest("POST", "/api/non-conformances", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/non-conformances"] });
      setDialogOpen(false);
      form.reset();
      toast({ title: "Non-conformance created successfully" });
    },
    onError: () => {
      toast({ title: "Failed to create non-conformance", variant: "destructive" });
    },
  });

  const filtered = ncs?.filter(
    (nc) =>
      nc.title.toLowerCase().includes(search.toLowerCase()) ||
      nc.ncNumber.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="p-6 space-y-6 overflow-auto h-full">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-ncs-title">Non-Conformances</h1>
          <p className="text-muted-foreground text-sm">Track and resolve quality issues</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-add-nc">
              <Plus className="h-4 w-4 mr-2" />
              New NC
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Create Non-Conformance</DialogTitle>
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
                        <Input {...field} placeholder="NC title" data-testid="input-nc-title" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="ncNumber"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>NC Number</FormLabel>
                        <FormControl>
                          <Input {...field} placeholder="NC-001" data-testid="input-nc-number" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="severity"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Severity</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value}>
                          <FormControl>
                            <SelectTrigger data-testid="select-nc-severity">
                              <SelectValue placeholder="Select severity" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="critical">Critical</SelectItem>
                            <SelectItem value="major">Major</SelectItem>
                            <SelectItem value="minor">Minor</SelectItem>
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
                    name="source"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Source</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value}>
                          <FormControl>
                            <SelectTrigger data-testid="select-nc-source">
                              <SelectValue placeholder="Select source" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="audit">Audit</SelectItem>
                            <SelectItem value="inspection">Inspection</SelectItem>
                            <SelectItem value="customer-complaint">Customer Complaint</SelectItem>
                            <SelectItem value="internal-report">Internal Report</SelectItem>
                          </SelectContent>
                        </Select>
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
                          <Input {...field} placeholder="Department" data-testid="input-nc-department" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={form.control}
                  name="assignedTo"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Assigned To</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="Responsible person" data-testid="input-nc-assigned" />
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
                          placeholder="Describe the non-conformance"
                          data-testid="input-nc-description"
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
                  <Button type="submit" disabled={createMutation.isPending} data-testid="button-submit-nc">
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
          placeholder="Search non-conformances..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
          data-testid="input-search-ncs"
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
                  <TableHead>NC #</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead>Assigned To</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((nc) => (
                  <TableRow key={nc.id} data-testid={`row-nc-${nc.id}`}>
                    <TableCell className="font-mono text-sm">{nc.ncNumber}</TableCell>
                    <TableCell>{nc.title}</TableCell>
                    <TableCell>
                      <Badge variant={severityColors[nc.severity] || "secondary"}>
                        {nc.severity}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={nc.status === "open" ? "outline" : nc.status === "closed" ? "default" : "secondary"}>
                        {nc.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="capitalize">{nc.source.replace("-", " ")}</TableCell>
                    <TableCell>{nc.department}</TableCell>
                    <TableCell>{nc.assignedTo}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {format(new Date(nc.createdAt), "MMM d, yyyy")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="py-12 text-center text-muted-foreground">
              <AlertTriangle className="mx-auto h-8 w-8 mb-2 opacity-50" />
              <p className="text-sm">No non-conformances found</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
