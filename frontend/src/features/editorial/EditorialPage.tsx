import { zodResolver } from "@hookform/resolvers/zod";
import { Save } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { PageHeader } from "../../components/PageHeader";
import { EmptyState } from "../../components/AsyncState";

const formSchema = z.object({ author: z.string().trim().min(1, "Informe quem está revisando."), approved_en: z.string(), approved_pt: z.string() });
type EditorialForm = z.infer<typeof formSchema>;

export function EditorialPage() {
  const { register, handleSubmit, formState: { errors, isSubmitSuccessful } } = useForm<EditorialForm>({ resolver: zodResolver(formSchema), defaultValues: { author: "Operador", approved_en: "", approved_pt: "" } });
  return <section><PageHeader title="Revisão editorial" description="O texto aprovado é literal: a interface nunca normaliza acentos, espaços ou pontuação." />
  <div className="two-column"><form className="panel" onSubmit={handleSubmit(() => undefined)} noValidate><h2>Rascunho de cue</h2><p className="hint">O envio ao endpoint será conectado à seleção de cue na issue de timeline.</p>
    <label>Responsável<input {...register("author")} aria-invalid={Boolean(errors.author)} />{errors.author && <span className="field-error">{errors.author.message}</span>}</label>
    <label>Inglês aprovado<textarea {...register("approved_en")} rows={4} /></label>
    <label>Português aprovado<textarea {...register("approved_pt")} rows={4} /></label>
    <button className="primary-button" type="submit"><Save aria-hidden="true" /> Salvar revisão</button>{isSubmitSuccessful && <p role="status">Rascunho validado.</p>}</form>
    <EmptyState title="Selecione um projeto">A edição de cue, timing e palavras será exibida aqui quando houver uma cena selecionada.</EmptyState></div></section>;
}
