# Smart Learning Moment Overlay

**Status:** Diretriz oficial de produto aprovada  
**Projeto:** Nova Generator → iHub English  
**Documento:** Especificação inicial de experiência e interação  
**Apresentação escolhida:** Cartão central (Center Card Overlay)

## 1. Objetivo

O Smart Learning Moment Overlay é a experiência que transforma um instante relevante de um vídeo em uma oportunidade curta e contextualizada de aprendizagem.

A mini aula deve surgir dentro da experiência de reprodução, preservando a conexão visual e narrativa com a cena original. Ela não deve parecer um anúncio, uma página separada ou um popup genérico.

O nome oficial do padrão é **Smart Learning Moment Overlay**. A apresentação aprovada é o **Cartão central**.

## 2. Princípios obrigatórios

1. **A cena continua presente:** o vídeo permanece visível ao fundo durante a mini aula.
2. **Interrupção intencional:** o vídeo pausa no instante exato em que a expressão selecionada começa, usando o timestamp de disparo definido para o Smart Learning Moment.
3. **Cartão central:** a mini aula aparece em um cartão central sobre a área do player. Não usar painel lateral como apresentação padrão.
4. **Contexto antes da teoria:** explicar primeiro o sentido da expressão naquela cena; aprofundamentos ficam disponíveis por interação.
5. **Áudio próprio:** a mini aula possui controles de áudio independentes do áudio do vídeo.
6. **Retomada precisa:** ao continuar, o vídeo retoma do ponto correto, sem saltar a expressão nem avançar indevidamente.
7. **Experiência responsiva:** o cartão deve funcionar em desktop, tablet e celular, respeitando a área útil do player.
8. **Uma oportunidade por vídeo:** no fluxo atual, no máximo um Smart Learning Moment selecionado por vídeo.

## 3. Composição visual do Cartão central

### 3.1 Fundo e player

- Manter o frame do vídeo visível atrás do cartão.
- Aplicar escurecimento moderado e uniforme à área do vídeo para destacar o conteúdo sem apagar a cena.
- Preservar a identidade visual e a proporção do player.
- Evitar que a camada pareça uma troca de página ou um modal administrativo.
- O cartão deve ter contraste suficiente para leitura, hierarquia visual clara e limites bem definidos.

### 3.2 Hierarquia do cartão

A composição inicial deve seguir esta ordem:

1. **Identificação:** rótulo discreto “SMART LEARNING MOMENT”.
2. **Expressão:** expressão original em inglês, como elemento de maior destaque.
3. **Tradução ou sentido:** equivalente natural em português, sem depender de tradução literal.
4. **Áudio:** controle visível para ouvir a expressão ou a narração da mini aula.
5. **Contexto da cena:** explicação curta do que a expressão comunica naquele momento.
6. **Exploração contextual:** acesso a exemplos e à árvore de contextos.
7. **Ação de saída:** ação clara para continuar o vídeo.

A quantidade de conteúdo visível inicialmente deve ser controlada. O cartão apresenta primeiro o essencial; exemplos e aprofundamentos são revelados sob demanda.

## 4. Interações previstas

### 4.1 Ouvir novamente

- Reproduz o áudio correspondente à expressão ou ao segmento selecionado.
- A reprodução da mini aula não deve iniciar, interromper ou misturar acidentalmente o áudio do vídeo.
- O estado de reprodução deve ser perceptível: reproduzindo, pausado ou concluído.
- Deve ser possível ouvir novamente sem fechar o cartão.

### 4.2 Ver exemplos

- Abre exemplos contextualizados que demonstrem o uso da expressão.
- Os exemplos devem manter o inglês em destaque e oferecer suporte em português quando previsto no conteúdo.
- A expansão não deve deslocar o aluno para fora do player.

### 4.3 Explorar contextos

- Abre a árvore de contextos associada à expressão.
- Permite compreender como o mesmo padrão linguístico aparece em situações comunicativas diferentes.
- A exploração deve acontecer dentro do próprio cartão ou em uma expansão visual pertencente a ele, sem substituir a experiência do vídeo.

### 4.4 Continuar vídeo

- Fecha o overlay com uma transição breve e discreta.
- Retoma a reprodução a partir do ponto de pausa correto.
- Não deve reiniciar o vídeo nem pular o trecho que contém a expressão.
- O comportamento deve ser consistente mesmo que o aluno tenha reproduzido o áudio da mini aula várias vezes.

## 5. Fluxo de reprodução

1. O vídeo é reproduzido normalmente.
2. O player alcança o timestamp de disparo do Smart Learning Moment.
3. A reprodução é pausada no instante definido.
4. O Cartão central aparece sobre o vídeo, com o fundo moderadamente escurecido.
5. O aluno ouve a expressão, consulta a explicação e, se desejar, explora exemplos e contextos.
6. Ao selecionar “Continuar vídeo”, o cartão desaparece e a reprodução é retomada do ponto correto.

A pausa deve usar o timestamp específico do disparo (trigger_start_ms), não simplesmente o início da legenda/cue que contém a expressão.

## 6. Regras de áudio

- O áudio da mini aula é independente da trilha de áudio do vídeo.
- Deve haver controle explícito para reproduzir novamente os segmentos disponíveis.
- A troca entre áudio do vídeo e áudio pedagógico precisa evitar sobreposição sonora.
- O fechamento do overlay deve deixar o player em um estado de áudio previsível.
- A experiência de reprodução do aluno é distinta da prévia de áudio no Nova Generator: a prévia de autoria serve para revisar a qualidade do material gerado antes da exportação; o Overlay consome os áudios aprovados no conteúdo final.

## 7. Responsividade

### Desktop
- Cartão centralizado na área do vídeo.
- Largura limitada para preservar a leitura e deixar a cena perceptível ao redor.
- Conteúdo adicional pode expandir o cartão sem se transformar em painel lateral.

### Tablet
- Cartão central com dimensões adaptadas ao espaço disponível.
- Manter a expressão, explicação e ações principais visíveis sem rolagem excessiva.

### Celular
- Cartão adaptado à largura útil do player, com margens seguras.
- Priorizar expressão, sentido, áudio e ação de continuar.
- Conteúdo complementar pode ser expandido dentro do cartão.
- Evitar controles pequenos ou áreas de toque apertadas.

## 8. Acessibilidade e qualidade de uso

- Contraste adequado entre texto, cartão e fundo.
- Tipografia legível e hierarquia consistente.
- Controles identificáveis por texto ou ícone acompanhado de rótulo acessível.
- Áreas de toque adequadas em dispositivos móveis.
- Não depender apenas de cor para indicar estados de áudio ou interação.
- Respeitar preferências de movimento reduzido, evitando animações indispensáveis para compreender o fluxo.

## 9. Fora do escopo desta primeira definição

Este documento aprova a direção visual e os princípios de interação, mas não fecha ainda:

- medidas exatas, tokens visuais, tipografia e animações;
- layout final de cada estado interno do cartão;
- comportamento detalhado da árvore de contextos em dispositivos pequenos;
- regras de acessibilidade específicas da implementação;
- persistência de progresso ou métricas de interação;
- implementação do player no iHub.

Esses pontos serão detalhados em etapas posteriores, mantendo as decisões aprovadas neste documento.

## 10. Critérios de aceite para futuras implementações

Uma implementação do Smart Learning Moment Overlay só estará alinhada a esta diretriz quando:

- [ ] usar o Cartão central como apresentação padrão;
- [ ] manter o vídeo visível ao fundo;
- [ ] pausar no timestamp exato do disparo;
- [ ] apresentar expressão, sentido e explicação contextual com hierarquia clara;
- [ ] oferecer reprodução de áudio independente;
- [ ] permitir explorar exemplos e contextos sem sair da experiência do player;
- [ ] retomar o vídeo do ponto correto;
- [ ] adaptar-se a desktop, tablet e celular;
- [ ] respeitar o limite atual de um Smart Learning Moment selecionado por vídeo.

---

**Decisão registrada:** Cartão central aprovado como padrão oficial do Smart Learning Moment Overlay. Este documento é a referência inicial para as próximas etapas de design e implementação.
