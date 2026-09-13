# Perguntas frequentes — Seixo

**Última atualização: 13 de setembro de 2026**

> Este ficheiro é a fonte de revisão. A versão publicada (com páginas também
> em inglês e espanhol) vive no repositório público separado
> `Xeixos-corp/Seixo-Legal` (GitHub Pages). As versões são geradas a partir
> deste texto, para não se desencontrarem.
>
> Regra para manter isto útil: só entra aqui o que **não cabe dentro da app**.
> Tudo o que se possa explicar no momento da confusão deve ser explicado lá,
> não aqui — uma FAQ é onde a documentação apodrece quando a app muda.

## Preciso de número de telefone, de email ou de palavra-passe?

Não. Nenhum dos três, e não há sítio onde os pedir.

Quando abres a app pela primeira vez, ela cria uma identidade no teu telemóvel: um par de chaves criptográficas que nunca saem dali, e um identificador aleatório que não está ligado a nada teu. É tudo. Não há registo, não há sessão para iniciar, não há nada para esquecer.

A contrapartida está na pergunta seguinte, e vale a pena lê-la agora e não quando for tarde.

## Mudei de telemóvel. Como levo a minha conta comigo?

Antes de mudares, no telemóvel antigo: **Definições → Cópia de segurança → Criar cópia de segurança**.

Recebes duas coisas, e precisas das duas:

1. **Doze palavras.** Escreve-as num papel. São elas que abrem o ficheiro, e não existe mais nenhuma via.
2. **Um ficheiro cifrado.** Guarda-o onde quiseres — em Ficheiros, no iCloud, enviado para o computador. Não fica connosco.

Guarda-os **separados**. Um ficheiro sem as palavras não serve de nada a quem o encontre; as palavras sem o ficheiro também não.

No telemóvel novo, no primeiro ecrã, escolhe **«Já tenho uma cópia de segurança»**, indica o ficheiro e escreve as doze palavras.

O que atravessa: **quem tu és** — o teu ID e a tua chave. Os teus contactos continuam a falar contigo sem terem de te verificar outra vez. O que **não** atravessa: as mensagens. Ficam no telemóvel antigo e desaparecem de lá quando o temporizador delas chegar ao fim.

## Perdi o telemóvel e não tinha cópia de segurança. Conseguem recuperar a minha conta?

Não. E não é má vontade nem política da casa: **não temos como**.

A chave que decifra as tuas conversas só existiu dentro daquele telemóvel. Nunca a recebemos, nunca a guardámos, não há cópia em lado nenhum. Uma app onde o dono pudesse repor a conta de alguém seria uma app onde o dono pode entrar na conta de qualquer pessoa — e então nada do resto desta página seria verdade.

O que acontece na prática:

- A conta antiga fica no servidor sem ninguém a usá-la e **apaga-se sozinha ao fim de seis meses**.
- Podes começar de novo: abres a app, ficas com um ID novo e dizes aos teus contactos.
- Quem já falava contigo vai ver um aviso de que a tua chave de segurança mudou. É o sistema a funcionar bem, não uma avaria — é o mesmo aviso que apareceria se alguém se estivesse a tentar fazer passar por ti.

Se houver uma coisa a fazer depois de ler esta página, é a cópia de segurança.

## O que é o meu ID e a quem o posso dar?

É o teu endereço dentro da Seixo: uma sequência aleatória que não diz nada sobre ti — nem nome, nem país, nem telefone, porque a app nunca soube nada disso.

Encontra-lo em **«O meu ID»**, com um código QR. Quem estiver a teu lado lê o código; quem estiver longe recebe o ID copiado por onde te der jeito.

Podes dá-lo a quem quiseres. A única coisa que permite é iniciar uma conversa contigo — e se essa pessoa se tornar incómoda, bloqueia-la e deixa de te conseguir escrever.

## Porque é que as mensagens desaparecem? Posso mudar o tempo?

Porque é o que uma conversa faz quando ninguém a está a arquivar: acaba. Uma mensagem que já não existe não pode ser lida por quem pegue no telemóvel daqui a uns meses.

Dentro de cada conversa, no topo, escolhes: **30 segundos, 5 minutos, 1 hora, 1 dia ou 1 semana**. Começa em 1 dia.

Dois pormenores que ninguém descobre sozinho:

- A escolha aplica-se **às mensagens que tu envias**, nessa conversa. Cada pessoa decide pelas suas.
- Para uma única mensagem mais curta do que o costume, **mantém o dedo no botão de enviar** e escolhe o tempo. Só aparecem tempos mais curtos do que o da conversa: serve para dizer uma coisa de passagem, não para contornar o que a conversa combinou.

Quando o tempo acaba, a mensagem desaparece dos telemóveis e do servidor. O que não podemos prometer é o que está fora da app: quem tiver a mensagem à frente pode fotografá-la ou copiá-la, aqui como em qualquer lado.

## Porque é que a notificação não diz quem escreveu nem o que dizia?

Porque não há como dizer, e porque é melhor assim.

O servidor que envia a notificação **nunca viu o conteúdo** da mensagem — recebeu-a já cifrada. Nem sequer diz de que conversa se trata: essa informação não viaja na notificação, precisamente para que a Apple e o serviço de envio não fiquem a saber com quem falas. O texto genérico é escolhido pelo teu telemóvel, não por nós.

Efeito secundário que é uma vantagem: quem espreite o teu ecrã bloqueado não fica a saber nada. Ao abrires a app, ela leva-te à conversa certa.

Se uma conversa te incomoda sem ser ao ponto de a bloqueares, podes **silenciá-la**: mantém o dedo sobre ela na lista e escolhe «Silenciar».

## O que é o «número de segurança» e quando o devo comparar?

É a impressão digital da vossa conversa. Dentro de uma conversa, em **«Verificar»**, vês um número comprido — e a outra pessoa vê exactamente o mesmo, se estiverem mesmo a falar um com o outro e mais ninguém estiver pelo meio.

Compara-o **por outra via**: lado a lado, ou por chamada. Se bater certo, está tudo bem.

Se um dia a app te avisar que a chave de alguém **mudou**, quase sempre é porque essa pessoa reinstalou a app ou mudou de telemóvel. Mas é também o que se veria se alguém estivesse a tentar fazer-se passar por ela — e a app não tem como distinguir as duas coisas. Por isso pergunta-lhe, por outra via, antes de continuar.

## Vocês conseguem ler as minhas mensagens? O que é que o servidor sabe?

Ler, não. As mensagens são cifradas no teu telemóvel antes de saírem e a chave nunca sai de lá. O que chega ao servidor é um bloco que ele não consegue abrir.

O que ele **vê**, e que dizemos por inteiro na [política de privacidade](index.html):

- Que conversas existem e quem pertence a cada uma — é o mínimo para saber a quem entregar cada mensagem.
- De cada mensagem: a que conversa pertence, a hora e o tamanho. Nunca o conteúdo.
- Numa conversa a dois, **não guarda quem enviou**. **Num grupo, guarda** — quem recebe precisa de saber com que chave decifrar. Dizemos isto porque é verdade, não porque nos agrade.
- O teu endereço IP, como qualquer serviço na internet. A app não o esconde; se isso te importa, usa uma VPN.

Os nomes que dás aos contactos e os nomes dos grupos nunca chegam ao servidor em texto legível.

## Alguém me está a incomodar. O que faço?

- **Numa conversa a dois:** abre a conversa e carrega em **«Bloquear»**. Essa pessoa deixa de te conseguir escrever.
- **Num grupo:** abre **«Membros»** e bloqueia essa pessoa. As mensagens dela deixam de te chegar — no grupo e em qualquer conversa — enquanto ela continua no grupo e não fica a saber. Se preferires sair, há **«Sair»** no topo da conversa.
- **Para nos dizeres:** **«Denunciar»**, no topo da conversa, abre um email para nós. Descreve o que aconteceu e cola o texto em causa — não conseguimos ler as mensagens, por isso sem isso não temos como saber o que se passou.

Quem bloqueaste fica em **Definições → Bloqueados**, e podes desfazer.

## Como apago a minha conta, e o que é que desaparece?

**Definições → Apagar conta.** Não é um botão que limpa só este telemóvel:

- **No servidor:** a tua identidade, as tuas chaves, as tuas conversas, a tua lista de bloqueados e o teu token de notificações são apagados.
- **No telemóvel:** as chaves, as mensagens e tudo o resto que a app tinha guardado.

Se o servidor não confirmar a eliminação, nada é apagado localmente — ficas com a conta intacta e um erro à frente, em vez de meio telemóvel limpo e uma conta que não sabes se ainda existe.

O que não podemos apagar são as mensagens que já foram entregues ao telemóvel de outra pessoa. Essas ficam com ela até o temporizador delas acabar.

## Se eu não usar a app durante muito tempo, perco a conta?

Sim. Uma conta que passe **seis meses sem ser aberta é apagada**, com tudo o que lhe pertence.

É deliberado: o que nunca se apaga acaba por ser um arquivo, e um arquivo é uma coisa que alguém pode um dia exigir que se entregue. Para isto funcionar guardamos apenas o dia do último uso — nunca a hora.

Basta abrires a app de vez em quando. E repara que isto também se aplica a uma conta de que tenhas cópia de segurança: se a conta for apagada, a cópia deixa de servir para voltar a entrar.

## Há versão para Android ou para computador?

Por agora a Seixo é só para iPhone.

O Android está previsto — boa parte do trabalho já está feita, porque o núcleo criptográfico é o mesmo nos dois sistemas — mas não há data, e prefiro não inventar uma. Para computador não há planos.

## Não encontrei aqui a minha pergunta

Escreve para **seixo.app@proton.me**.

Uma nota sobre o que podemos responder: não conseguimos ver as tuas mensagens, nem as tuas conversas, nem quem são os teus contactos. Isso quer dizer que muita coisa que outro serviço resolveria por ti — «reponham-me a conta», «recuperem aquela mensagem» — aqui não tem solução do nosso lado. É o preço de tudo o resto que está nesta página.
