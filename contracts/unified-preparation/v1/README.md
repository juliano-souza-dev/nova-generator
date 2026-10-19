# Contrato de preparação única 1.0

O pacote é produzido imediatamente depois da transcrição, antes do Editorial.
Ele inclui o snapshot da transcrição e o Shadowing criado exclusivamente pelo
algoritmo determinístico do Generator. O retorno da Groq/IA externa inclui
apenas o Editorial 1.3 e o material pedagógico completo (sete seções e Anki).

A revisão editorial aprova o que a IA preparou. A etapa Shadowing reutiliza os
grupos pré-existentes pelos IDs das cues, reidrata EN/PT atuais e permite editar
e aprovar. Materiais revisa os cards e mini-aulas existentes, com aprovação
humana. Mudanças editoriais não descartam materiais; invalidam sua aprovação.

A publicação mantém o payload nativo aprovado em generatorShadowing e acrescenta
pedagogicalContent e os campos das mini-aulas em cues[].anki.items[] no hub_final.
A publicação de áudio continua sendo uma etapa humana distinta.

Rotas:
- GET /projects/{id}/media/preparation-package
- POST /projects/{id}/media/preparation-result
- POST /projects/{id}/media/preparation-groq

Compatibilidade: os fluxos externos editoriais 1.3/1.4 e materiais-ai/v1
permanecem acessíveis para projetos antigos e recuperação. O usuário não precisa
de um novo JSON nos estágios posteriores da nova jornada.
