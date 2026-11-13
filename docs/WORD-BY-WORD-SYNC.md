# Nova Generator
## Especificação: sincronização de legendas por palavra (Word by Word)

- **Versão:** 1.0
- **Data:** 13/11/2026
- **Status:** Diretriz aprovada para implementação incremental
- **Escopo:** sincronização temporal de palavras para legendas educacionais

---

## 1. Objetivo

Desenvolver um sistema de sincronização de legendas em nível de palavra (Word by Word), no qual cada palavra recebe destaque visual no momento mais próximo possível de sua pronúncia real no áudio original.

O objetivo vai além do efeito de karaokê convencional. Como o Nova Generator produz conteúdo educacional, a prioridade é a precisão temporal, a qualidade da edição e a eficiência do trabalho editorial.

## 2. Princípios fundamentais

1. Cada palavra deve possuir tempos próprios de início e término.
2. Os intervalos devem representar a pronúncia real, não uma divisão matemática e uniforme da duração da frase.
3. A sincronização automática será uma estimativa inicial, nunca uma verdade absoluta.
4. O usuário deverá manter controle total sobre os ajustes manuais.
5. Ajustar uma palavra não poderá alterar involuntariamente os tempos das demais.
6. O processamento deverá evitar operações desnecessárias e permitir evolução dos mecanismos sem reconstruir o editor.
7. A timeline, a prévia e a renderização final deverão respeitar a mesma fonte de tempos.
8. Os tempos deverão permanecer referenciados ao áudio original, inclusive quando o vídeo utilizado no projeto for um recorte.
9. A implementação será incremental: cada etapa deverá ser validada antes do avanço para a seguinte.

## 3. Separação de responsabilidades

O sistema será organizado em três responsabilidades independentes.

### 3.1. Transcrição

Determina o conteúdo textual falado. A transcrição poderá passar por revisão editorial antes da sincronização.

### 3.2. Alinhamento

Recebe uma transcrição conhecida e procura localizar no áudio os intervalos correspondentes a cada palavra.

A tecnologia a investigar é **Forced Alignment (alinhamento forçado)**. Diferentemente de uma transcrição convencional, o alinhador não precisa descobrir novamente o que foi falado: ele utiliza o texto fornecido como referência e estima onde cada palavra ocorre no áudio.

Possíveis soluções para avaliação:
- WhisperX e seu mecanismo de alinhamento;
- alinhadores baseados em CTC;
- outras implementações de alinhamento forçado que apresentem boa precisão, desempenho e facilidade de integração.

A escolha da tecnologia fica em aberto até uma avaliação técnica. Não assumir que uma ferramenta específica será obrigatoriamente adotada.

### 3.3. Editor de sincronização

Apresenta os tempos estimados e permite que o usuário valide e corrija cada palavra.

O editor deverá ser independente do mecanismo de alinhamento. Assim, será possível trocar ou aprimorar o processamento automático sem reconstruir a experiência de edição.

## 4. Experiência de edição

### 4.1. Seleção individual de palavras

- Cada palavra será uma unidade temporal editável.
- A seleção deverá identificar visualmente a palavra correspondente na timeline e na legenda.
- Os tempos de início e término deverão estar disponíveis para inspeção e edição.
- A palavra selecionada deverá receber destaque visual.

### 4.2. Ajuste visual na timeline

Permitir arrastar individualmente as extremidades dos intervalos de cada palavra.

Os ajustes deverão:
- preservar a precisão temporal;
- respeitar os limites válidos do intervalo;
- evitar alterações involuntárias em palavras vizinhas;
- oferecer feedback visual claro durante a edição.

Operações que alterem uma fronteira compartilhada ou ajustem palavras vizinhas deverão ser explícitas, nunca efeitos colaterais ocultos.

### 4.3. Ajuste por teclado

Implementar atalhos para operações de precisão. Proposta inicial, sujeita à validação durante a implementação:

| Ação | Comportamento proposto |
|---|---|
| Setas | Navegação ou ajuste temporal, conforme o contexto |
| Shift + setas | Ajuste de início ou término da palavra selecionada |
| Espaço | Reproduzir/pausar |
| Enter | Confirmar o ajuste ou a operação ativa |

Os incrementos temporais deverão ser configuráveis. O valor inicial sugerido é de 10 ms.

A combinação definitiva de teclas deverá respeitar os atalhos já existentes no Nova Generator.

### 4.4. Reprodução contextual

Ao selecionar uma palavra, disponibilizar a reprodução de um pequeno intervalo anterior e posterior a ela.

As margens contextuais deverão ser configuráveis. A finalidade é permitir que o editor avalie a pronúncia considerando a conexão entre palavras, sem depender de fragmentos sonoros isolados.

A reprodução contextual deverá manter a referência temporal correta entre áudio, vídeo e timeline.

### 4.5. Visualização da forma de onda (waveform)

Incorporar a forma de onda do áudio como auxílio visual para identificar:
- início de emissões sonoras;
- pausas;
- ataques de sílabas;
- regiões de maior intensidade.

A waveform será uma referência auxiliar, não uma representação definitiva dos limites fonéticos. Sons de baixa intensidade e fonemas fracos podem não produzir limites visuais evidentes.

## 5. Modelo de dados conceitual

Cada palavra deverá possuir, no mínimo:
- texto;
- tempo inicial;
- tempo final;
- origem do tempo (automática ou manual).

Exemplo ilustrativo:

```json
{
  "text": "What are you doing?",
  "words": [
    { "word": "What", "start": 1.20, "end": 1.48, "source": "automatic" },
    { "word": "are", "start": 1.48, "end": 1.63, "source": "automatic" },
    { "word": "you", "start": 1.63, "end": 1.81, "source": "manual" },
    { "word": "doing?", "start": 1.81, "end": 2.25, "source": "automatic" }
  ]
}
```

Os valores são apenas ilustrativos. Os tempos deverão manter precisão de milissegundos.

O modelo definitivo deverá ser compatível com a estrutura de projetos e os contratos já utilizados pelo Nova Generator. Este documento não define ainda o schema final nem autoriza alterações incompatíveis nos contratos existentes.

## 6. Regras de integridade temporal

- Todo intervalo deverá possuir início e término válidos.
- O início deverá ser anterior ao término.
- Os tempos deverão estar dentro da duração válida da mídia de referência.
- Ajustes individuais não deverão deslocar palavras não selecionadas.
- Sobreposições e lacunas não deverão ser corrigidas silenciosamente. Quando relevantes, deverão ser sinalizadas para revisão.
- A aplicação deverá preservar a distinção entre tempos estimados automaticamente e tempos corrigidos manualmente.
- Uma nova execução do alinhamento não deverá sobrescrever silenciosamente ajustes manuais já realizados. A política de reaplicação deverá ser definida antes da integração automática.
- A conversão entre tempo do áudio original e tempo relativo ao recorte deverá ser explícita e consistente.

## 7. Estratégia de implementação em etapas

### Etapa 1. Estrutura de edição manual

- Avaliar e aproveitar a linha de tempos já existente na timeline.
- Definir a representação individual das palavras.
- Implementar seleção e identificação dos intervalos.
- Implementar edição de início e término.
- Estabelecer regras de integridade temporal.

**Critério de validação:** selecionar e ajustar palavras individualmente sem alterar involuntariamente as demais.

### Etapa 2. Reprodução contextual

- Reproduzir o intervalo da palavra selecionada.
- Incluir margens anteriores e posteriores.
- Permitir validação auditiva dos tempos.
- Manter áudio, vídeo e timeline sincronizados durante a reprodução.

**Critério de validação:** o editor consegue ouvir e conferir rapidamente uma palavra em seu contexto.

### Etapa 3. Controles de precisão

- Implementar atalhos de teclado.
- Implementar incrementos temporais configuráveis.
- Permitir ajustes independentes de início e término.
- Validar conflitos com atalhos existentes.

**Critério de validação:** realizar correções finas sem depender exclusivamente do mouse.

### Etapa 4. Waveform

- Incorporar a visualização da forma de onda.
- Sincronizar sua navegação com vídeo e timeline.
- Permitir utilizá-la como referência para ajustes manuais.

**Critério de validação:** a waveform auxilia a localização dos limites sem prejudicar a fluidez do editor.

### Etapa 5. Alinhamento automático

- Avaliar soluções de Forced Alignment.
- Selecionar a tecnologia considerando precisão, desempenho, dependências e facilidade de distribuição.
- Gerar tempos iniciais por palavra.
- Permitir revisão e correção manual de todos os resultados.
- Preservar ajustes manuais ao reaplicar o processamento, conforme política explícita.

**Critério de validação:** o alinhamento automático produz uma base útil e editável, sem retirar o controle do usuário.

### Etapa 6. Validação da exportação

- Garantir correspondência entre prévia e renderização.
- Preservar os tempos editados no arquivo final.
- Validar o comportamento em vídeos recortados.
- Confirmar que a referência ao áudio original é convertida corretamente.
- Testar frases com palavras rápidas, prolongadas, conectadas e com pausas.

**Critério de validação:** o destaque de cada palavra na exportação ocorre nos mesmos tempos definidos e validados no editor.

## 8. Decisões ainda em aberto

As questões abaixo deverão ser discutidas antes das respectivas etapas, sem antecipar decisões desnecessárias:

1. Interação em tempo real: avaliar se o usuário poderá marcar início e término de palavras enquanto acompanha a reprodução do vídeo.
2. Atalhos definitivos e comportamento de cada modo de ajuste.
3. Margens padrão e configuração da reprodução contextual.
4. Tecnologia de Forced Alignment e estratégia de execução local ou externa.
5. Política de reaplicação do alinhamento automático sobre palavras já corrigidas manualmente.
6. Schema definitivo e integração com os contratos existentes.
7. Estratégia de cache e processamento para evitar recalcular alinhamentos sem necessidade.

## 9. Diretriz de desenvolvimento

A implementação deverá seguir a abordagem de **baby steps**.

Não iniciar pela recuperação do código antigo da branch `backup`. Primeiro, construir e validar a nova metodologia. O código existente poderá ser consultado posteriormente, de forma pontual, quando houver uma necessidade técnica concreta.

A prioridade é desenvolver uma solução mais robusta, eficiente em processamento e precisa na sincronização, sem carregar limitações de uma implementação anterior.

**Próximo passo aprovado:** iniciar a Etapa 1, analisando a timeline atual e definindo a menor implementação funcional de edição manual por palavra.

## 10. Arquitetura de execução e processamento incremental

Decisões aprovadas em 13/11/2026:

### 10.1. Propriedade do recurso pelo Shared Runtime Manager

O Shared Runtime Manager é o único proprietário do recurso de Forced Alignment e de todos os seus componentes compartilhados:

- ambiente Python virtual e isolado, localizado dentro da instalação global do Shared;
- WhisperX e suas dependências;
- worker de alinhamento;
- modelos acústicos e cache dos modelos;
- caminhos absolutos provisionados para as aplicações autorizadas/declarantes.

O Nova Generator não instalará Python, WhisperX ou modelos por conta própria, não manterá cópias locais desses recursos e não construirá caminhos a partir de uma pasta presumida. Deverá descobrir os caminhos exclusivamente pelo vínculo local `shared.config.json` provisionado pelo Shared Runtime Manager.

A dependência `forced-alignment` será opcional no contrato da aplicação para evitar downloads grandes durante o registro ou sincronização comum. A instalação será explícita pelo Shared Runtime Manager:

```powershell
srm install forced-alignment --app nova-generator
```

Depois da instalação, o Shared disponibilizará o diretório resolvido em `shared.resources.forced-alignment`. Outras aplicações poderão declarar e reutilizar o mesmo recurso.

### 10.2. Whisper e Forced Alignment

O Whisper já utilizado pelo Nova Generator continua responsável pela transcrição. O Forced Alignment não deve transcrever novamente o áudio.

O alinhador receberá:
- o trecho de áudio correspondente ao bloco;
- o texto original transcrito naquele bloco;
- o idioma efetivamente falado.

A tradução nunca será utilizada como entrada do alinhador. Traduções permanecem independentes dos timestamps das palavras originais.

WhisperX será a primeira implementação a ser avaliada. A escolha poderá ser revista se os testes de precisão, compatibilidade, desempenho ou distribuição não forem satisfatórios.

### 10.3. Worker persistente

O Shared provisionará um worker com protocolo JSON Lines. O Nova poderá iniciar o processo usando os caminhos fornecidos no vínculo Shared e enviar uma requisição por linha.

O worker deverá:
- manter o processo ativo durante a sessão de alinhamento;
- carregar o modelo acústico uma vez por idioma e reutilizá-lo entre blocos;
- responder individualmente a cada requisição;
- isolar erros por requisição, sem encerrar o worker por falha em um bloco;
- armazenar modelos e caches exclusivamente nos diretórios globais do Shared.

CPU será suportada. CUDA poderá ser utilizada automaticamente quando disponível.

### 10.4. Processamento por bloco e retomada

O alinhamento será executado sobre os blocos individuais já produzidos pela transcrição, sem exigir nova transcrição integral.

Cada bloco terá estado independente:
- pendente;
- processando;
- concluído;
- falhou.

O resultado de cada bloco deverá ser persistido assim que validado. Uma falha não poderá invalidar resultados concluídos anteriormente. Ao retomar, somente blocos pendentes, falhos ou invalidados deverão ser processados novamente.

O cache deverá considerar, no mínimo:
- identidade/hash do áudio de referência e do intervalo utilizado;
- texto original do bloco;
- idioma;
- versão do worker e do modelo acústico.

### 10.5. Contexto acústico nas fronteiras

Para reduzir erros nas palavras conectadas entre blocos, o áudio enviado ao alinhador poderá incluir pequenas margens anteriores e posteriores ao intervalo principal.

O resultado deverá ser convertido para a referência temporal absoluta do áudio original. Palavras pertencentes apenas às margens não poderão ser duplicadas em blocos vizinhos.

A estratégia exata de margem e deduplicação será validada com amostras reais antes de ser fixada.

### 10.6. Preservação de edição manual

A reaplicação do alinhamento automático não poderá sobrescrever silenciosamente tempos corrigidos manualmente. O estado de cada palavra deverá preservar a origem do timestamp e a política de invalidação deverá atuar apenas sobre o bloco afetado.

### 10.7. Incremento de implementação atual

O primeiro incremento provisiona o recurso centralizado no Shared e expõe o caminho resolvido ao Nova Generator. A próxima etapa é integrar o worker persistente ao backend do Nova, executar um único bloco de ponta a ponta e validar o contrato de entrada/saída antes de habilitar o processamento em lote.
