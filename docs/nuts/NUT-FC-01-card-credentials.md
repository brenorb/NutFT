# NUT-FC-01 — Card credentials over Cashu

**Status:** proposta local experimental; não é uma NUT oficial atribuída pelo
protocolo Cashu.  
**Versão:** 1  
**Escopo:** envelope de credenciais de cartas colecionáveis digitais.

## 1. Motivação

Cashu `Proof` conhece valor, unidade, mint, segredo e assinatura. Ele não
conhece `card_id`, definição de carta, raridade, slot de booster ou proprietário
da credencial.

NUT-FC-01 define um envelope de aplicação que transporta um proof Cashu de
valor `1` junto com referências NutFC. A unidade `card` representa uma carta
individual; a identidade e as propriedades são ligadas por uma credencial
NutFC, não por campos arbitrários dentro do `Proof`.

Esta proposta não define:

- um novo algoritmo de assinatura Cashu;
- um novo sistema de provas ZK;
- uma política universal de boosters;
- um sorteio justo obrigatório;
- um ledger alternativo ao estado gasto da mint.

## 2. Envelope

O formato canônico é JSON UTF-8 compacto, com chaves ordenadas para hashing e
assinatura:

```json
{
  "protocol": "nutfc",
  "version": 1,
  "mint": "https://mint.example",
  "cashu": {
    "mint": "https://mint.example",
    "unit": "card",
    "proofs": [
      {
        "id": "nutfc-card-v1",
        "amount": 1,
        "secret": "<opaque-card-commitment>",
        "C": "<cashu-signature>",
        "dleq": {
          "e": "<hex>",
          "s": "<hex>",
          "r": "<hex>"
        }
      }
    ]
  },
  "nutfc": {
    "version": 1,
    "collection_id": "set-alpha",
    "card_commitment": "<same-value-as-cashu-secret>",
    "definition_hash": "<signed-card-definition-hash>",
    "rarity": "rare",
    "owner_public_key": "<compressed-secp256k1-key>",
    "slot_id": "rare",
    "booster_id": "<optional-booster-id>",
    "policy_id": "<optional-policy-id>"
  }
}
```

`cashu.proofs` deve seguir o modelo de `cashu.core.base.Proof` de
`cashu==0.20.2`. O proof deve ter `amount=1`, unidade `card` e um `secret`
igual ao `card_commitment` NutFC.

## 3. Privacidade

O envelope público não inclui:

- `card_id`;
- `owner_secret`;
- `salt`;
- abertura completa do commitment;
- chave privada do dono.

O `definition_hash` é uma referência pública. O cliente pode obter a definição
assinada pelo catálogo e revelar o `card_id` apenas numa apresentação de carta.

O envelope não é, por si só, uma prova de que o commitment abre para uma carta
válida. Essa relação exige a abertura local, uma apresentação seletiva ou uma
prova ZK futura.

## 4. Apresentação de posse

Para a primeira versão, a wallet pode apresentar:

```json
{
  "protocol": "nutfc-possession-v1",
  "challenge": "<nonce-do-verificador>",
  "collection_id": "set-alpha",
  "card_id": "set-alpha:001",
  "definition_hash": "<hash>",
  "card_commitment": "<hash>",
  "owner_public_key": "<compressed-key>",
  "signature": "<assinatura-do-desafio>"
}
```

A assinatura cobre o desafio, o commitment, o `card_id` e o
`definition_hash`. O verificador confirma a definição no catálogo, verifica a
assinatura da mint e consulta o estado atual da mint antes de aceitar a carta.

Esta apresentação revela a identidade da carta para aquele verificador, mas
não revela o `owner_secret` nem o `salt`. Uma apresentação de “possuo uma carta
com tais atributos sem revelar qual” exigirá um sistema ZK separado.

## 5. Transferência

Uma apresentação de posse não substitui uma troca. A transferência usa:

```text
consume(old_card_credential, owner_challenge_response,
        same_definition_proof, new_blinded_destination)
    -> issue(new_card_credential)
```

O commitment novo é diferente do antigo. O destino novo é gerado pela wallet
do comprador e o fator de blinding não deve ser entregue ao vendedor.

No protótipo local, a mint recebe a credencial completa para validar a relação
entre abertura e definição. Isso é uma limitação conhecida, não uma propriedade
de privacidade final. A versão privada exigirá uma prova ZK de equivalência
entre a carta antiga e o destino novo.

## 6. Compatibilidade Cashu

Um cliente Cashu genérico pode reconhecer a seção `cashu` apenas se aceitar a
unidade `card` e a mint correspondente. Ele não entenderá as garantias NutFC,
como `definition_hash`, ownership ou policy de booster.

Um cliente NutFC deve:

1. validar a estrutura Cashu;
2. validar a relação `cashu.proofs[0].secret == nutfc.card_commitment`;
3. validar a definição e a assinatura da mint;
4. manter a abertura fora do envelope público;
5. aplicar as regras NutFC antes de exibir ou aceitar a carta.

## 7. Boosters

Booster policies e resultados são referências opcionais no envelope por meio
de `booster_id`, `slot_id` e `policy_id`. A composição concreta pertence à
policy da aplicação.

A primeira implementação confia na mint para executar a policy. Uma futura
extensão pode adicionar commitments de entropia conjunta e uma prova
verificável de sorteio sem alterar o formato básico da `CardCredential`.

## 8. Estado experimental

NUT-FC-01 é uma proposta para discussão. Antes de submeter algo ao protocolo
Cashu, ainda são necessários:

- revisão do uso de `unit=card` por wallets Cashu existentes;
- especificação formal do compromisso e do nullifier;
- testes de canonicalização e vetores de interoperabilidade;
- modelo persistente e idempotente de transferência;
- revisão criptográfica independente;
- decisão sobre transformar o envelope num NUT oficial ou mantê-lo como
  extensão de aplicação.
