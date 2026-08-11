# NutFT — Especificação do protocolo

**Status:** draft de arquitetura e protocolo  
**Versão:** 0.1  
**Atualizado:** 2026-08-09

## 1. Resumo

NutFT é um protocolo de cartas colecionáveis digitais privadas, inspirado em
Magic: The Gathering e construído sobre primitivas Cashu/Nutshell.

Uma empresa opera a mint. A mint é simultaneamente a fábrica digital das
cartas, a autoridade que define o catálogo e as regras de distribuição, e a
autoridade que impede double spend. Os boosters são emitidos digitalmente e
abertos em cartas individuais. Cada carta pode ser guardada, jogada, provada
ou trocada separadamente.

O objetivo não é criar supply fixo por carta. A empresa pode vender novos
boosters indefinidamente. O objetivo é tornar pública a política de
distribuição por raridade e, como extensão desejável, permitir que qualquer
pessoa audite a justiça do sorteio. O protocolo deve impedir que:

- a wallet invente cartas que não pertencem ao catálogo;
- uma carta gasta seja reutilizada;
- a mint escolha ou descubra desnecessariamente a carta específica recebida;
- a wallet apresente uma carta fora da policy publicada;
- uma troca aceite apenas uma prova antiga sem consumir o ativo original.

Esta especificação descreve um protocolo novo de *private collectible ecash*.
Cashu/Nutshell fornece a camada de blind signatures, proofs e estado de gasto,
mas não fornece sozinho boosters, metadados de cartas, provas de raridade ou
provas ZK de equivalência entre commitments.

## 2. Escopo da primeira versão do protocolo

A primeira versão completa deve permitir:

1. publicar um catálogo assinado de cartas;
2. publicar uma política assinada de boosters;
3. comprar e abrir um booster;
4. receber várias `CardCredential`, uma por slot do booster;
5. manter o `card_id` e a posse da carta privados para observadores e para a
   mint, quando o protocolo de emissão permitir; as propriedades são públicas
   no catálogo depois que a carta é identificada;
6. provar a validade de uma carta e de suas propriedades;
7. provar posse atual para jogar ou negociar;
8. trocar uma carta através de `consume(old) → issue(new)` atómico;
9. rejeitar reuso, replay, cartas fora do catálogo e raridades inválidas;
10. permitir que um cliente de jogo leia as propriedades assinadas da carta
    sem hard-code de cada carta.

A prova de que o sorteio foi justo é um *nice to have* do protocolo. Sem essa
extensão, a mint continua responsável por executar honestamente a
`BoosterPolicy`; com ela, o comprador e auditores independentes podem verificar
que o resultado foi derivado corretamente sem a mint precisar revelar as
cartas individuais.

O primeiro corte implementado no repositório cobre o núcleo local: catálogo e
policy assinados, compra e abertura de booster com sorteio confiado na mint,
credenciais individuais, challenge-response de posse, envelope Cashu estendido
e transferência atómica em memória. Ele ainda não implementa sorteio
verificável, persistência, idempotência após crash ou provas ZK.

## 3. Modelo de confiança

### 3.1 Mint/fábrica

A mint é confiável para:

- publicar e versionar o catálogo;
- publicar a política de boosters;
- assinar credenciais válidas;
- manter o conjunto de nullifiers gastos;
- aceitar ou recusar emissão e transferência;
- aplicar a política de distribuição, se a prova criptográfica a obrigar.

A mint não deve precisar conhecer:

- a identidade da carta que uma wallet guarda;
- o vínculo entre uma carta e a identidade social do jogador;
- a abertura privada de um commitment;
- o conteúdo de uma partida;
- o histórico público de proprietários.

A mint continua sendo uma autoridade central. Ela pode censurar, ficar offline,
emitir novas cartas, alterar políticas futuras ou comportar-se de forma
maliciosa. NutFT não promete descentralização, supply fixo ou solvência da
empresa.

### 3.2 Wallet

A wallet guarda:

- a abertura secreta de cada carta;
- o segredo usado para o nullifier;
- a credencial assinada;
- os commitments e provas de que precisa para gastar ou revelar;
- material de recuperação, quando esse recurso existir.

A wallet não pode criar uma carta válida apenas escolhendo um JSON. Ela precisa
de uma credencial da mint e de uma prova que ligue a credencial a uma definição
válida do catálogo.

### 3.3 Cliente de jogo

O cliente de jogo pode receber uma abertura ou uma prova seletiva e interpretar
as propriedades declarativas da carta. O cliente não deve executar código
arbitrário vindo do token. As regras devem usar um schema versionado e um
conjunto limitado de efeitos conhecidos pelo motor do jogo.

### 3.4 Rede social e relays

Nostr, Blossom ou outro transporte pode distribuir catálogo, imagens, ofertas e
mensagens, mas não é a fonte de verdade da propriedade. Relays podem atrasar,
duplicar, censurar ou observar tráfego.

## 4. Terminologia

- **Collection:** conjunto versionado de cartas.
- **CardDefinition:** definição pública e assinada de uma carta.
- **Card opening:** dados secretos que identificam uma carta e seu dono.
- **Card commitment:** compromisso criptográfico da abertura.
- **CardCredential:** credencial assinada que autoriza uma carta.
- **BoosterPolicy:** regras públicas de composição e distribuição.
- **Booster:** unidade digital comprada e aberta uma única vez.
- **Slot:** posição de uma carta dentro de um booster, associada a uma classe
  de raridade.
- **Nullifier:** identificador derivado do segredo que permite à mint impedir
  reuso sem expor a abertura completa.
- **Selective disclosure:** revelação de apenas os atributos necessários.
- **Proof of possession:** prova de que a wallet controla a credencial agora.
- **Atomic transfer:** operação que consome a credencial antiga e emite a nova
  na mesma transação lógica da mint.

## 5. CardDefinition

O catálogo contém definições de cartas, não tokens individuais. Uma definição
deve ser imutável dentro de uma versão da collection e assinada pela mint.

Exemplo conceitual:

```json
{
  "protocol": "nutft-card-definition",
  "version": 1,
  "collection_id": "set-alpha",
  "card_id": "set-alpha:001",
  "name": "Black Lotus",
  "rarity": "mythic",
  "image": {
    "url": "blossom://event-or-pointer",
    "sha256": "..."
  },
  "game_schema": "mtg-like-v1",
  "properties": {
    "cost": 0,
    "types": ["artifact"],
    "power": null,
    "toughness": null,
    "abilities": [
      {
        "type": "add_mana",
        "colors": ["white", "blue", "black", "red", "green"]
      }
    ]
  },
  "definition_hash": "...",
  "issuer_signature": "..."
}
```

Requisitos:

- `card_id` é único dentro da collection e versão;
- `rarity` pertence ao vocabulário da `BoosterPolicy`;
- a imagem é endereçada por ponteiro, mas protegida por hash de conteúdo;
- `properties` usa schema declarativo e versionado;
- a definição não pode ser alterada silenciosamente depois de emitida;
- uma alteração de regras cria uma nova versão de collection ou definition;
- o token pode carregar o hash da definição sem carregar a imagem inteira.

O `card_id` pode ser revelado ao jogar ou trocar. A privacidade pretendida é
que ele não apareça para a mint, relays ou observadores enquanto a wallet não
precisar revelá-lo.

## 6. Abertura e commitment da carta

Uma abertura conceitual contém:

```text
opening = {
  collection_id,
  card_id,
  definition_hash,
  rarity,
  slot_id,
  booster_id,
  owner_secret,
  salt
}
```

O formato criptográfico exato ainda precisa ser fixado. Conceitualmente:

```text
card_commitment = H(domain || canonical_encode(opening))
nullifier = H(domain || owner_secret || card_commitment)
```

O commitment não deve revelar o `card_id`, a raridade ou o conteúdo da carta.
O `owner_secret` e o `salt` devem ser gerados pela wallet com aleatoriedade
criptograficamente segura.

A credencial pública deve conter somente o material necessário para a mint e o
verificador, por exemplo:

```json
{
  "protocol": "nutft-card",
  "version": 1,
  "mint": "https://mint.example",
  "collection_id": "set-alpha",
  "card_commitment": "...",
  "nullifier_key_id": "...",
  "credential": "cashu-or-nutft-credential",
  "proof": "..."
}
```

A implementação não deve chamar o commitment de prova de validade. O
commitment só compromete-se com uma abertura; a validade exige uma credencial
da mint e uma prova verificável.

## 7. Boosters e distribuição

A `BoosterPolicy` é uma interface do protocolo para descrever slots, raridades
e algoritmo. A composição concreta é configuração da aplicação. A prova
criptográfica de justiça do sorteio descrita na seção 7.3 é opcional e deve ser
implementada depois do núcleo de posse e transferência.

### 7.1 Política

Cada época/versão de boosters publica uma política assinada. Ela define:

- collection e versão do catálogo;
- número de slots por booster;
- classe de raridade de cada slot;
- distribuição dentro de cada classe;
- se há reposição ou quotas por lote;
- versão do algoritmo de sorteio;
- seed/compromisso e regras de entropia;
- validade e preço do booster, quando aplicável.

Exemplo conceitual de composição:

```json
{
  "policy_id": "set-alpha:season-1",
  "collection_id": "set-alpha",
  "slots": [
    {"slot_id": "rare", "rarity": "rare", "count": 1},
    {"slot_id": "uncommon", "rarity": "uncommon", "count": 3},
    {"slot_id": "common", "rarity": "common", "count": 8}
  ],
  "draw_mode": "independent-per-slot",
  "algorithm": "nutft-draw-v1",
  "policy_hash": "...",
  "issuer_signature": "..."
}
```

Os números acima formam o perfil da primeira implementação (`1 rare`, `3
uncommon`, `8 common`). Eles não fazem parte do protocolo criptográfico: o
protocolo recebe uma `BoosterPolicy` versionada e funciona com qualquer número
de slots, classes e regras de distribuição válidas.

### 7.2 Supply variável

NutFT não fixa quantas unidades de uma carta existirão para sempre. A política
define como cada booster é composto e pode ser aplicada a uma quantidade
variável de boosters vendidos.

Uma afirmação como “10% mythic” precisa declarar se significa:

- sorteio independente por slot;
- quota exata dentro de cada lote;
- distribuição sem reposição dentro de uma época;
- ou apenas uma probabilidade anunciada.

Sem essa escolha, “proporção” não é uma propriedade verificável.

### 7.3 Extensão opcional: sorteio justo e privado

O objetivo desta extensão é que a mint conheça o catálogo e a política, mas
não precise aprender qual carta individual foi atribuída a uma wallet, e que o
resultado possa ser auditado por terceiros.

Um fluxo conceitual é:

```text
1. Mint publica commitment de sua entropia/política.
2. Wallet escolhe entropia privada e publica apenas um commitment.
3. Mint fornece sua contribuição aleatória ou uma resposta verificável.
4. Wallet calcula os resultados dos slots.
5. Wallet cria commitments para as cartas resultantes.
6. Wallet prova em ZK que os resultados seguem a policy e o catálogo.
7. Mint assina cegamente as credenciais dos commitments.
```

Quando esta extensão estiver habilitada, o protocolo precisa impedir que a
wallet escolha livremente uma carta rara e apresente um resultado inventado.
Também precisa impedir que a mint escolha o resultado depois de conhecer toda
a entropia da wallet.

Commit-reveal simples não basta se uma das partes puder escolher sua semente
depois de observar a outra. A construção final deve especificar o compromisso,
as contribuições de entropia, a ordem das mensagens e a prova de correção. Sem
essa extensão, a mint é a autoridade confiável para a execução da policy.

## 8. Compra e abertura de booster

### 8.1 Compra

Comprar um booster produz uma `BoosterCredential` ou equivalente. Ela deve ser
um direito de abertura único, não uma autorização reutilizável.

Antes de abrir, a wallet valida:

- identidade da mint;
- assinatura e versão da policy;
- collection e catálogo associados;
- preço e unidade, se Cashu for usado para pagamento;
- validade e nonce do booster.

### 8.2 Abertura

Abrir um booster consome a credencial do booster e produz uma lista de
`CardCredential` individuais. Cada carta tem:

- commitment próprio;
- credencial própria;
- slot e raridade comprováveis;
- abertura guardada na wallet;
- referência à definição assinada;
- nullifier próprio.

Se a resposta da mint se perder, a abertura precisa ser recuperável com um
identificador idempotente. A mint não pode emitir duas vezes o mesmo booster.

### 8.3 Falhas

Uma abertura não pode ficar parcialmente concluída sem estado recuperável. O
protocolo precisa distinguir:

- falha antes de consumir o booster;
- consumo confirmado sem todas as cartas entregues;
- resposta perdida depois da emissão;
- emissão inválida ou prova rejeitada;
- mint indisponível durante a recuperação.

## 9. Validação de uma carta

Um verificador deve poder confirmar, conforme o nível de revelação:

### 9.1 Validade completa

Recebe a abertura, a definição e a credencial. Confirma:

- a definição é assinada pela mint;
- o `definition_hash` corresponde ao conteúdo;
- a abertura corresponde ao `card_commitment`;
- a credencial foi emitida para esse commitment;
- a raridade da abertura corresponde à policy;
- o nullifier ainda não foi consumido, quando a mint for consultada.

### 9.2 Revelação seletiva

Revelação seletiva não é uma prova ZK. É o mecanismo mais simples para a
primeira versão: a wallet revela apenas os campos necessários e mantém os
segredos criptográficos fora da mensagem. Como as definições e propriedades
das cartas são públicas no catálogo, normalmente basta revelar o `card_id` e
provar que a wallet controla a credencial correspondente.

Uma revelação seletiva pode conter:

```text
collection_id = set-alpha
rarity = mythic
card_id = set-alpha:001
power >= 5
```

O verificador não precisa receber o `salt`, o `owner_secret`, o commitment
interno ou outras propriedades não relacionadas à partida. O conteúdo
revelado deve ser acompanhado por uma assinatura/prova vinculada a um desafio
novo do verificador. Assim, o verificador sabe que a wallet controla a
credencial, e não apenas que alguém copiou um JSON antigo.

Se a privacidade exigida for “provar que tenho uma carta desta classe sem dizer
qual carta é”, então revelação seletiva deixa de ser suficiente e será
necessária uma prova ZK de atributo.

### 9.3 Prova de posse atual

Uma prova de “eu possuo ou possuí um Black Lotus” não é suficiente para uma
troca. Ela pode referir-se a uma credencial já gasta.

Na primeira versão, a posse atual será demonstrada por revelação seletiva mais
challenge-response. A wallet deve responder a um desafio novo, vinculado a:

- o verificador;
- a sessão;
- a collection/card definition;
- uma consulta de estado ou prova de não-gasto da mint;
- uma expiração curta.

Para uma troca, a operação correta continua sendo a transferência atómica, não
uma prova solta. A challenge-response prova controle naquele momento, mas a
mint ainda precisa confirmar o estado não gasto ou executar diretamente o
`consume_and_issue`.

## 10. Transferência atómica

O vendedor e o comprador negociam fora da mint, possivelmente usando Nostr.
O comprador cria um novo destino cego para o mesmo ativo.

Conceitualmente:

```text
consume_and_issue(
  old_credential,
  proof_same_card,
  old_nullifier,
  new_blinded_destination
)
```

A mint deve, numa transação lógica:

1. verificar a credencial antiga;
2. verificar a prova de que o commitment antigo e o destino novo representam
   a mesma carta;
3. verificar que o nullifier antigo ainda não foi gasto;
4. verificar validade, destinatário, nonce e expiração;
5. produzir a nova credencial;
6. marcar o nullifier antigo como gasto;
7. devolver um recibo mínimo.

Se qualquer etapa falhar, a carta antiga deve continuar válida. Se a resposta
for perdida depois do commit, a operação deve ser recuperável por um
`operation_id` idempotente.

O novo commitment deve ser diferente do antigo, mesmo quando representa a
mesma carta. Isso evita carregar o histórico de propriedade e impede que o
mesmo bearer seja apresentado como duas instâncias de posse.

## 11. Modos de uso

### 11.1 Jogar

O cliente de jogo importa a wallet localmente, lê as definições e propriedades
necessárias e cria provas de posse para a partida. O jogo pode exigir uma
consulta online à mint antes de aceitar uma carta, dependendo do modelo de
double-spend da partida.

O protocolo não deve assumir que revelar a carta ao adversário é sempre
indesejável: em muitos jogos, a carta é pública quando entra em campo. A
privacidade protege principalmente mão, coleção, histórico e observadores
externos.

### 11.2 Trocar

As partes podem revelar seletivamente a carta que está sendo negociada, mas a
liquidação deve consumir a credencial antiga e produzir uma nova para o
comprador. Uma oferta Nostr nunca deve conter um proof reutilizável, segredo,
abertura completa ou preimage de settlement.

### 11.3 Colecionar

Uma wallet pode mostrar nomes, imagens e raridades localmente. Se o usuário
publicar uma coleção, ele escolhe explicitamente quais definições e provas
revela. A mint não deve publicar automaticamente o inventário de uma wallet.

## 12. Formato lógico do token

O formato exato ainda depende da extensão escolhida sobre Cashu. A separação
recomendada é:

O protótipo usa a proposta local [NUT-FT-01](nuts/NUT-FT-01-card-credentials.md)
para o envelope Cashu estendido. Ela não é uma NUT oficial e não altera os
proofs Cashu; acrescenta referências NutFT e regras de apresentação.

```json
{
  "protocol": "nutft",
  "version": 1,
  "mint": "https://mint.example",
  "unit": "card",
  "credential": {
    "commitment": "...",
    "signature": "...",
    "proof_system": "nutft-zk-v1"
  },
  "cashu": {
    "proofs_or_reference": "..."
  },
  "opening": "wallet-local-or-encrypted",
  "definition_ref": "set-alpha:definition-hash",
  "booster_ref": "set-alpha:booster-id",
  "slot_ref": "rare-1"
}
```

O campo `opening` não deve ser interpretado como público apenas porque aparece
num envelope serializado. Para transporte externo, ele deve ficar fora do
token público, cifrado para o dono, ou protegido por uma construção que não o
revele à mint.

Ainda falta decidir se o `cashu` será:

- um proof Cashu real com extensão NutFT;
- uma credencial separada que usa Cashu apenas como settlement;
- ou uma nova unidade/protocolo compatível apenas no nível das primitivas.

## 13. Requisitos de segurança

A primeira implementação criptográfica deve testar pelo menos:

- commitment não revela `card_id` por inspeção direta;
- abertura alterada invalida a credencial;
- carta fora do catálogo é rejeitada;
- raridade incompatível é rejeitada;
- prova de booster incorreta é rejeitada, quando a extensão de sorteio justo
  estiver habilitada;
- nonce ou operação repetida não emite novamente;
- nullifier repetido é rejeitado;
- transferência não expõe o `card_id` à mint, se essa for a propriedade
  prometida pela versão;
- o mesmo ativo não pode ser transferido duas vezes;
- falha antes do commit não gasta o ativo antigo;
- resposta perdida pode ser recuperada sem emissão duplicada;
- a imagem recebida corresponde ao hash da definição;
- propriedades de jogo não podem executar código arbitrário.

## 14. Fora do escopo da primeira implementação

- blockchain ou consenso global;
- supply fixo por carta;
- marketplace custodial ou escrow;
- reputação social;
- Nostr como ledger de propriedade;
- imagens armazenadas dentro do token;
- execução arbitrária de regras de jogo;
- promessa de anonimato absoluto;
- recuperação sem trade-offs de privacidade;
- produção com dinheiro real antes de revisão criptográfica independente.

## 15. Estado atual do repositório

O código atual implementa:

- `Asset` e `AssetCatalog` locais;
- `CardDefinition` e `BoosterPolicy` assinadas pela mint;
- credencial individual com abertura, commitment e nullifier;
- assinatura blindada usando `cashu==0.20.2`;
- compra e abertura de boosters configuráveis, com prevenção de reabertura;
- prova de posse atual com chave do dono e challenge-response;
- envelope Cashu estendido sem serializar a abertura privada;
- `LocalMint.consume_and_issue` atómico em memória;
- rejeição de double spend e credencial inválida;
- CLI e testes unitários.

O código atual ainda não implementa:

- sorteio com entropia conjunta;
- prova ZK de catálogo, raridade ou correção do sorteio (extensão opcional);
- persistência da mint;
- idempotência e recuperação após perda de resposta ou crash;
- cliente de jogo;
- Nostr/Blossom.

No corte local, a operação de transferência ainda entrega a credencial antiga
completa à `LocalMint` para que ela valide a abertura. O envelope público não
contém essa abertura, mas a privacidade contra a própria mint ainda depende da
prova ZK de equivalência prevista para uma versão futura.

## 16. Decisões de produto já tomadas

As respostas atuais fecham três decisões de escopo:

1. A primeira implementação usará, como exemplo, boosters com 1 rara, 3
   incomuns e 8 comuns. A composição é configuração da policy, não parte fixa
   do protocolo.
2. As definições e propriedades das cartas são públicas no catálogo. O
   protocolo protege a posse, a abertura e o vínculo entre a wallet e a carta;
   não precisa esconder as regras depois que o `card_id` for revelado.
3. A primeira versão deve provar posse atual. O mecanismo inicial será
   revelação seletiva com challenge-response; provas ZK serão adicionadas quando
   for necessário provar atributos sem revelar o `card_id`.
4. A prova criptográfica de que o sorteio do booster foi justo é um *nice to
   have*, não um requisito para fechar o núcleo inicial. A primeira versão pode
   confiar na mint para executar honestamente a policy; a extensão futura deve
   permitir auditoria independente sem revelar as cartas individuais.

Ainda faltam decisões criptográficas de implementação, especialmente o formato
exato da challenge-response, o vínculo entre a credencial e a chave do dono,
o circuito ZK do sorteio e o formato final de armazenamento Cashu/NutFT. Essas
decisões podem ser fechadas depois do primeiro protótipo de posse.
