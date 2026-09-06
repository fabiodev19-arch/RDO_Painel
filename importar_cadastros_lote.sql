-- ============================================================================
-- GTM RDO — importação em lote de cadastros (carga inicial via planilha)
-- ============================================================================
-- Recebe um array de {categoria, valor} e insere tudo de uma vez com
-- ON CONFLICT DO NOTHING -- valores que já existem são silenciosamente
-- ignorados (não gera erro, não duplica), e o retorno diz quantos eram
-- novos e quantos já existiam, pra o painel mostrar um resumo direito.
-- ============================================================================

CREATE OR REPLACE FUNCTION importar_cadastros_lote(p_itens jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item jsonb;
  v_categoria text;
  v_valor text;
  v_inseridos int := 0;
  v_ja_existiam int := 0;
  v_invalidos int := 0;
  v_id uuid;
BEGIN
  PERFORM exige_mfa();

  FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p_itens, '[]'::jsonb))
  LOOP
    v_categoria := v_item->>'categoria';
    v_valor := trim(coalesce(v_item->>'valor', ''));
    IF v_categoria IS NULL OR v_valor = '' THEN
      v_invalidos := v_invalidos + 1;
      CONTINUE;
    END IF;

    v_id := NULL;
    INSERT INTO cadastros (categoria, valor, ativo, ordem)
    VALUES (v_categoria, v_valor, true, 0)
    ON CONFLICT (categoria, valor) DO NOTHING
    RETURNING id INTO v_id;

    IF v_id IS NOT NULL THEN
      v_inseridos := v_inseridos + 1;
    ELSE
      v_ja_existiam := v_ja_existiam + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'inseridos', v_inseridos,
    'ja_existiam', v_ja_existiam,
    'invalidos', v_invalidos
  );
END;
$$;

GRANT EXECUTE ON FUNCTION importar_cadastros_lote(jsonb) TO authenticated;
