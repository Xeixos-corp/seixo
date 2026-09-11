# Política de privacidade — Seixo

**Última atualização: 11 de setembro de 2026**

> Este ficheiro é a fonte de revisão. A versão publicada (com páginas também
> em inglês e espanhol) vive no repositório público separado
> `Xeixos-corp/Seixo-Legal` (GitHub Pages). As quatro versões são geradas
> a partir do mesmo texto, para não se desencontrarem.

Esta política descreve, de forma exata e verificável em relação ao código-fonte real da app, que dados a app Seixo recolhe, quem mais tem acesso a eles, durante quanto tempo, e como podes pedir a sua eliminação.

Responsável pelo tratamento de dados: Bruno, developer individual da app Seixo. Contacto: **seixo.app@proton.me**.

## Em resumo

- Não pedimos número de telefone, nome, email nem acesso aos teus contactos.
- O servidor nunca consegue ler as tuas mensagens: são cifradas no teu telemóvel antes de saírem.
- Quase tudo o que o servidor guarda apaga-se sozinho — dizemos abaixo quando.
- Não usamos publicidade, análise nem rastreio de terceiros.

## O que o servidor guarda

**Sobre a tua conta:**

- **Um identificador aleatório**, criado quando abres a app pela primeira vez. Não está ligado a nenhum dado teu.
- **A tua chave pública de identidade e chaves públicas temporárias** (protocolo Signal), para outras pessoas poderem iniciar conversas cifradas contigo. As chaves privadas nunca saem do teu telemóvel.
- **A data do último uso** — só o dia, nunca a hora — para podermos apagar contas abandonadas.
- **A lista de pessoas que bloqueaste**, visível só para ti.
- **Um token de notificações** do teu telemóvel e os textos genéricos que o teu telemóvel escolheu mostrar (por exemplo, «Tens uma mensagem nova.»). Nunca incluem o conteúdo nem quem enviou.

**Sobre as tuas conversas:**

- **Que conversas existem e quem pertence a cada uma** e, nos grupos, quem é o dono. É o mínimo para o servidor saber a quem entregar cada mensagem.
- **As mensagens, sempre cifradas.** De cada uma, o servidor vê a conversa a que pertence, a hora exata, o tamanho e se deve gerar notificação — nunca o conteúdo.
- **Quem enviou:** numa conversa a dois, não é guardado. **Num grupo, o servidor consegue ver quem enviou cada mensagem** enquanto essa mensagem existir, porque quem a recebe precisa de saber com que chave a decifrar.
- **Os nomes dos grupos e os nomes que dás aos contactos** nunca chegam ao servidor em texto legível.

**Só se criares uma cópia de segurança:**

- **Um endereço e uma palavra-passe derivados das tuas 12 palavras de recuperação**, para poderes voltar à mesma conta noutro telemóvel. O endereço termina em `@seixo.invalid`: não é um email real, não recebe correio e não revela nada sobre ti. A palavra-passe é guardada em forma irreversível.
- **O ficheiro da cópia não fica connosco.** Fica onde tu o guardares, e só abre com as tuas 12 palavras, que nunca recebemos.

## Endereços IP

Como qualquer serviço na internet, o servidor vê o endereço IP de onde te ligas. O que fazemos com isso:

- O serviço de autenticação regista o IP e o tipo de dispositivo em cada sessão. **Apagamos esses dois campos a cada minuto.**
- O registo de auditoria da autenticação é apagado ao fim de **uma hora**.
- O fornecedor de alojamento mantém registos técnicos dos pedidos, que incluem o IP, durante um período curto definido por ele e que não controlamos.

A app não esconde o teu IP. Se isso for importante para ti, usa uma VPN ou Tor.

## Permissões do telemóvel

- **Câmara**: só para ler o código QR de um contacto. A imagem é processada no telemóvel e nunca é enviada nem guardada.
- **Microfone**: só para gravares mensagens de voz, quando carregas no botão. A gravação é cifrada no telemóvel antes de sair.
- **Face ID**: só para desbloquear a app, se ativares o bloqueio. É tratado pelo próprio sistema do telemóvel; nada sai do aparelho.
- **Notificações**: para saberes que chegou uma mensagem.

## O que não recolhemos

Número de telefone, nome, email real (exceto se nos escreveres para suporte), lista de contactos do telemóvel, localização, fotografias e identificadores de publicidade. Não usamos nenhum SDK de análise, rastreio ou publicidade.

## Durante quanto tempo guardamos os dados

- **Mensagens**: apagadas do servidor quando acaba o temporizador que escolheres — entre 30 segundos e 1 semana, para a conversa ou só para uma mensagem — mesmo que ninguém abra a app.
- **Mensagens de voz**: no servidor, no máximo **24 horas**, ou menos se o temporizador for mais curto. Quem não abrir a app nesse prazo não as recebe.
- **Conversas**: uma conversa com mais de 7 dias é apagada do servidor, com a lista de membros, assim que deixa de ter mensagens por expirar.
- **Chaves temporárias nunca usadas**: 30 dias.
- **Contas**: apagadas ao fim de **6 meses sem abrires a app**, com tudo o que lhes pertence. Uma cópia de segurança dessa conta deixa de funcionar.
- **Lista de bloqueados, token de notificações e credenciais da cópia de segurança**: enquanto a conta existir.
- **Endereços IP**: ver a secção acima.

## Quem mais tem acesso aos teus dados

- **As pessoas da conversa** — só elas conseguem decifrar o conteúdo, nos telemóveis delas.
- **Supabase Inc.**, que aloja a base de dados e o servidor na União Europeia (Paris). Tem acesso aos dados descritos acima e ao conteúdo cifrado, que não consegue ler.
- **Expo (650 Industries, Inc.) e Apple**, que encaminham as notificações até ao teu telemóvel. Recebem o token e o texto genérico da notificação — nunca o conteúdo nem o remetente.
- **Proton AG**, só se nos escreveres para seixo.app@proton.me.
- **Ninguém mais.** Não vendemos, alugamos nem partilhamos dados com publicidade, redes sociais ou quaisquer outros terceiros.

## Denúncias

O botão para denunciar um contacto abre a tua app de email com uma mensagem já preenchida, que inclui o identificador desse contacto. Nada é enviado até carregares em enviar.

## Os teus direitos

- **Eliminar a tua conta e todos os dados**: a qualquer momento, em Definições → «Eliminar conta e todos os dados». Apaga do servidor a tua identidade, chaves, participação em conversas, lista de bloqueados, token de notificações e credenciais da cópia de segurança, e limpa os dados do teu telemóvel. As mensagens que já enviaste continuam cifradas até o temporizador as apagar, e qualquer cópia de segurança que tenhas guardado deixa de funcionar.
- **Aceder, corrigir ou pedir uma cópia dos teus dados**: escreve para seixo.app@proton.me. Como não sabemos quem és, podemos pedir-te o ID que aparece na app para encontrar os dados.
- Se estiveres na União Europeia, estes direitos correspondem aos direitos de acesso, retificação, apagamento e portabilidade previstos no RGPD.

## Segurança

As mensagens são cifradas ponta-a-ponta com o protocolo Signal (PQXDH e Double Ratchet), através da biblioteca oficial `libsignal`. As tuas chaves ficam cifradas no telemóvel, protegidas pelo Keychain (iOS) ou Keystore (Android), e as chaves temporárias de sessão são renovadas a cada 2 dias. Isto não é uma garantia absoluta: nenhuma app te protege se o teu próprio telemóvel estiver comprometido, ou se alguém fotografar o ecrã com outro aparelho.

## Menores de idade

A app não é dirigida a crianças e não pedimos, conscientemente, dados de menores de idade. Não temos atualmente um mecanismo de verificação de idade.

## Alterações a esta política

Se esta política mudar de forma significativa, isso será refletido nesta página com a data de atualização revista.

## Contacto

Dúvidas, pedidos relacionados com os teus dados, ou denúncias: **seixo.app@proton.me**
