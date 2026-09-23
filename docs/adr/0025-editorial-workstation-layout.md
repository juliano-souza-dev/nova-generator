# ADR 0025 — Estação de revisão editorial orientada ao cue

## Status

Aceita.

## Contexto

A revisão combinava dados de demonstração com projetos reais e distribuía reprodução, timeline, texto e timing em blocos sem uma sequência operacional clara. Controles técnicos ocupavam o mesmo nível das ações editoriais e a timeline podia ampliar a largura da página.

## Decisão

A revisão será uma única estação composta por cinco regiões desacopladas:

1. contexto de projeto, cena e progresso;
2. player do corte sincronizado;
3. timeline com viewport próprio;
4. editor do cue e inspetor contextual de palavras;
5. barra persistente de ações da revisão.

Dados de demonstração não fazem parte da rota de produção. O estado vazio orienta a escolha de um projeto e o estado sem cues aguarda a saída da transcrição. Tempos humanos aparecem como contexto; milissegundos ficam nos ajustes finos. Texto EN/PT continua literal e é salvo pelos contratos editoriais existentes.

A timeline pode rolar internamente quando sua largura mínima exceder o viewport, mas nunca deve criar overflow horizontal na página. Controles por ícone recebem nome acessível e atalhos ficam em ajuda recolhível.

## Consequências

- A integração com ingestão só precisa fornecer projeto, cena, mídia e cues; não existe dependência de fixtures de demonstração.
- A barra de ações torna salvar e aprovar acessíveis durante a rolagem.
- Ajustes de cue e palavra continuam separados nos contratos da API, embora sejam apresentados no mesmo contexto.
- A barra expõe somente ações com efeito real nos contratos atuais: salvar alterações e aprovar o cue. Novas ações só entram na interface depois que possuírem persistência e resultado verificável.
- Testes de interface devem cobrir 1366×768 e 1440×900, ausência de overflow da página, navegação de cue e preservação literal de EN/PT.
